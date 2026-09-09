# decisions.md — global, project-wide decisions

Every meaningful technical decision that's true for the *whole* project, not
specific to one phase/milestone. Phase-specific decisions (e.g. JWT design
choices, made while building Phase 1's auth) live in that phase's own
`decisions.md` instead — see `masterdoc/README.md` for the index. Format per
entry:

- **What we chose**
- **What else we considered, and why not**
- **What scenario/problem this actually protects against or solves**

Purpose, same as every decisions.md in this project: this is partly a
refresher project — the goal isn't just working code, it's being able to
explain *why* each piece is the way it is in an interview.

This repo holds two services — `api/` (Spring Boot) and `verify/`
(Node/Express) — see `architecture.md`. Entries #1–#5 below predate
`verify/` and are specifically about `api/`'s stack (Maven, Spring Boot
itself, its dependencies); #6 covers `verify/`'s own stack choices; #7 is
about the repo structure itself.

---

## 1. Java 21 + Spring Boot (not Node/NestJS, not Django)

- **Chose:** Spring Boot, Java 21 (current LTS).
- **Considered:** Node.js/NestJS (same language as the Next.js frontend —
  would've been the technically "easiest" pick) and Django (fastest CRUD +
  free admin panel).
- **Why this instead:** This is explicitly a resume-refresh project — Spring
  Boot is the most in-demand backend skill in the target job market, and
  there's prior Java background to reactivate rather than learn cold. A
  same-language Node backend would've been operationally simpler but
  wouldn't have added a distinct, recognizable skill to the resume the way
  "Next.js frontend + Spring Boot backend" does.
- **Scenario it covers:** N/A (this is the foundational stack choice, not a
  feature-level decision) — but it's the reason every decision below has to
  be explained in Spring-idiomatic terms rather than "whatever's fastest in
  Node."

## 2. Maven (with the Maven Wrapper `mvnw`), not Gradle

> **How the project was actually scaffolded, no IDE:** IntelliJ's "New
> Project → Spring" wizard is a GUI front-end over **Spring Initializr**
> (`start.spring.io`) — it sends your group/artifact/dependency choices to
> that service as an HTTP request and unpacks the generated zip it gets
> back. Working from a terminal, we called that identical service directly:
> `curl start.spring.io/starter.zip -d groupId=... -d dependencies=web,security,...
> -o project.zip`, then unzipped it. Same service, same generated project
> either way — just the API instead of the GUI. See
> `masterdoc/README.md`'s "how to explain this" framing if asked in an
> interview context.

- **Chose:** Maven, via the `mvnw`/`mvnw.cmd` wrapper scripts Spring
  Initializr generates alongside the project.
- **Considered:** Gradle (faster incremental builds, more flexible for
  multi-module setups).
- **Why this instead:** Maven's XML is more verbose but far more common in
  Spring Boot job postings/interview contexts, and its declarative
  dependency model is easier to reason about when relearning the ecosystem
  rather than optimizing build speed. The wrapper means Maven doesn't need
  to be installed system-wide (it wasn't, on this machine) — `./mvnw`
  downloads the exact pinned Maven version into `.mvn/wrapper/` the first
  time it runs, so the build is reproducible on any machine without a
  manual install step.
- **Scenario it covers:** "Works on my machine" build drift — anyone who
  clones this repo gets the exact same Maven version automatically, no
  separate install or version-mismatch debugging.

## 3. Spring Boot 4.1.1 (latest stable), not 3.x

> **Correction while scaffolding:** first attempt used the version string
> `4.1.1.RELEASE` (copying an old pre-3.0 Spring Boot naming habit —
> versions haven't carried a `.RELEASE` suffix since Spring Boot 3.0).
> Spring Initializr's `/starter.zip` rejected it outright (`Invalid Spring
> Boot version`), and a `search.maven.org` lookup for the correct bare
> version number (`4.1.1`) initially came back showing nothing past
> `3.5.3` — that's `search.maven.org`'s search *index* lagging behind
> actual publishes, not the real repository state. Checking Maven Central's
> authoritative `maven-metadata.xml` directly (rather than the search
> index) confirmed `4.1.1` is genuinely published, and regenerating with
> that exact string worked. Lesson: when a package registry's search
> UI/API disagrees with what a build tool expects, trust the registry's own
> metadata file over its search index.

- **Chose:** `4.1.1` — Spring Initializr's current default stable version.
- **Considered:** Pinning to 3.x, which is what most existing
  tutorials/prior experience will reference.
- **Why this instead:** No reason to deliberately start a new project on an
  older major version — 4.x is the current stable line. One concrete
  difference worth knowing: starters that used to be one artifact now
  sometimes split into a `-test` companion module (e.g.
  `spring-boot-starter-webmvc` + `spring-boot-starter-webmvc-test`) —
  visible in `pom.xml`'s dependency list. Also, `spring-boot-starter-web` is
  now `spring-boot-starter-webmvc` (there's a separate `-webflux` starter
  for the reactive stack, which this project does *not* use — it's a
  traditional blocking/synchronous REST service: nothing about this domain
  needs reactive backpressure handling, and blocking code is far easier to
  reason about, test, and explain in an interview). Three more Spring Boot 4
  package-relocation surprises hit while building Phase 1 specifically —
  see `phase-1-auth-rbac/explain_boot4-migration.md`.
- **Scenario it covers:** Avoiding building on an already-superseded major
  version on day one of a fresh project.

## 4. Dependency selection (`pom.xml`)

- **`spring-boot-starter-webmvc`** — the REST layer (`@RestController`,
  etc.). Chosen over `-webflux` (reactive) because this service has no
  I/O-bound high-concurrency requirement that would justify reactive's
  added complexity — the one genuinely slow call (the verify-service HTTP
  call on submit, once built) is a single synchronous call per request, not
  a fan-out of hundreds, so blocking threads are fine and much simpler to
  write/test/debug.
- **`spring-boot-starter-security`** — the whole authentication/
  authorization filter chain (`SecurityFilterChain`, `@PreAuthorize`,
  password encoding) instead of hand-rolling auth middleware. This is the
  single biggest reason Spring Boot suits the RBAC requirement
  (admin/contributor/user) — role checks become one annotation on a
  controller method, not manual `if` checks scattered through the codebase.
- **`spring-boot-starter-data-jpa`** — Spring Data JPA (Hibernate
  underneath) for the ORM layer. Chosen over hand-written
  JDBC/`JdbcTemplate` because the domain has real relationships (users →
  attempts → scenarios) that benefit from an ORM's repository abstraction
  (`JpaRepository<Attempt, UUID>` gives CRUD + query derivation for free),
  and because Testcontainers integration testing works cleanly against it.
- **`postgresql`** (JDBC driver, runtime scope) — the actual DB client.
  Runtime scope because application code never imports it directly; it's
  only needed at runtime by the JDBC layer underneath JPA/Flyway.
- **`spring-boot-starter-flyway`** — versioned SQL migrations
  (`V1__auth.sql`, `V2__scenario.sql`, ...) instead of Hibernate's
  `ddl-auto=update` auto-schema generation. Chosen deliberately:
  auto-generated schemas drift unpredictably and are impossible to review
  in a PR diff or reproduce identically across dev/CI/prod. Flyway
  migrations are plain SQL files, committed to git, applied in order, and
  are exactly what the plan's milestone-per-migration structure needs.
- **`spring-boot-starter-validation`** — Bean Validation (`@NotBlank`,
  `@Email`, etc.) on request DTOs, enforced automatically at the controller
  boundary via `@Valid`. Chosen over manual validation `if` blocks for the
  same reason as Security's annotations: declarative, less error-prone,
  less code to review.
- **`spring-boot-starter-actuator`** — exposes `/actuator/health` etc. out
  of the box. Included because Railway/Render (the planned deploy targets)
  both use an HTTP health check to know whether a deploy succeeded — this
  is the endpoint they hit.
- **`testcontainers` + `testcontainers-postgresql` + `spring-boot-testcontainers`**
  — integration tests run against a *real* ephemeral Postgres in a Docker
  container, not an in-memory fake (like H2) or mocked repositories. See
  `explain_testing.md` for the full reasoning and how it actually works.
- **`lombok`** — generates boilerplate (`@Getter`/`@Setter`/`@Builder`/
  `@RequiredArgsConstructor`) at compile time so entity/DTO classes stay
  short. Considered leaving it out (plain Java, more explicit, arguably
  easier to read while relearning the language) — kept it because it's the
  overwhelming convention in real Spring Boot codebases and interview
  take-homes; not using it would make the code look unfamiliar compared to
  what you'll see on the job.

## 5. Package-by-feature structure (`auth/`, `scenario/`, `attempt/`, ...), not layer-by-layer (`controllers/`, `services/`, `repositories/`)

- **Chose:** each bounded context (auth, scenario, attempt, points,
  progress, leaderboard, dailychallenge, ai, admin) is its own package
  containing its own entities, repository, service, controller, and DTOs
  together.
- **Considered:** the classic Spring tutorial layout — one `controllers/`
  package, one `services/` package, one `repositories/` package, all
  features mixed together inside each.
- **Why this instead:** the attempt-submit flow (once built) has to
  orchestrate points, progress, leaderboard, and daily-challenge logic in
  one transaction — with layer-by-layer packaging, understanding that one
  flow means jumping between 4+ unrelated files in `services/` next to a
  dozen other features' services. Package-by-feature keeps everything one
  feature needs physically together, so the code that changes together
  lives together. This is also the more common layout in real-world
  (non-tutorial) Spring Boot codebases at this project's scale.
- **Scenario it covers:** Codebase navigability as the app grows past "toy
  CRUD app" size — specifically, the multi-feature orchestration in
  `AttemptService` that the whole anti-cheat design depends on.

## 6. `verify/`'s own stack: Express + `tsx` (run directly, no build step), Vitest

- **Chose:** Node/Express, TypeScript run directly via `tsx` (both `npm run dev` and `npm start` — no separate `tsc` compile step, no `dist/`), Vitest for tests.
- **Considered:** a compiled build step (`tsc` → `dist/`, run with plain `node`); Fastify instead of Express; Jest instead of Vitest.
- **Why this instead:** this service is intentionally thin (per the plan's
  own framing — "one real job," a handful of files, see
  `phase-4-verify-service-integration/explain_verify.md`), so a build step
  buys nothing a small, fast-starting service needs — `tsx` transpiles on
  the fly with negligible overhead, and skipping `dist/` means there's
  exactly one copy of the source to reason about, never a stale compiled
  artifact to accidentally deploy. Express over Fastify: Express is the
  default anyone reaches for first, and this service's entire HTTP surface
  is two routes (`/health`, `/verify`) — nothing here exercises the
  performance/plugin-ecosystem differences that would make choosing
  between them matter. Vitest over Jest: Vite-native, fast, and it's what
  the frontend's own repo would reach for if it had a Vitest suite (it
  currently doesn't, but the tooling generation is the same either way) —
  no meaningful reason to prefer Jest here.
- **Scenario it covers:** N/A — stack choice, not a feature-level decision.

## 7. One repo (`api/` + `verify/`), not two — reconsidered after starting with two

- **Chose:** a single `engineering-studio-backend` repo, `api/` and
  `verify/` as subdirectories, `masterdoc/` at the repo root covering both.
- **Considered, and actually built first:** two entirely separate repos,
  `engineering-studio-api` and `engineering-studio-verify` — the original
  plan's own framing ("two new repos, siblings to the untouched frontend").
- **Why this changed:** the original reasoning (different languages/build
  tools) didn't hold up under scrutiny — a monorepo doesn't require one
  language, only one `.git` with subdirectories, each keeping its own
  `pom.xml`/`package.json` untouched. What actually matters weighed the
  other way for this project specifically: independent deployability is
  unaffected either way (Railway/Render both deploy from a subdirectory of
  one repo just as well as from a dedicated repo), the vendoring
  relationship with the frontend crosses a repo boundary regardless of how
  `api`/`verify` are arranged, and for a **solo-developer portfolio
  project**, one clone showing the whole backend — API and the verify
  microservice and how they call each other — reads better to a reviewer
  than asking them to open two repos and infer the relationship. The one
  real thing given up is independent git history/tags per service, judged
  a small cost here. Made at the cheapest possible moment to make it —
  neither repo had been `git init`'d yet, so this was a directory move, not
  a history rewrite.
- **Scenario it covers:** N/A — repo-structure decision, not a
  feature-level one. Logged because it was a deliberate reversal of an
  earlier decision, made after actually building both pieces and seeing
  how they related in practice, not decided in the abstract up front.
