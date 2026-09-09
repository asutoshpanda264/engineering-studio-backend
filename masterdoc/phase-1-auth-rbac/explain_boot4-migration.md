# explain_boot4-migration.md — three Spring Boot 4 package moves hit while building Phase 1

Not a "why we chose X" decision — this is "how to find it" knowledge, hit
three separate times while scaffolding auth. Filed as its own explain doc
rather than three decisions.md entries because the useful takeaway is the
*technique*, not any individual choice.

## What kept happening

A familiar Spring Boot class (something used the same way for years) failed
to import, with the compiler saying the package it's always lived in simply
doesn't exist anymore. This happened three times in one scaffolding session:

1. **`@AutoConfigureMockMvc`** — the old import
   (`org.springframework.boot.test.autoconfigure.web.servlet`) is gone.
   Real location: `org.springframework.boot.webmvc.test.autoconfigure`.
2. **The default Jackson `ObjectMapper` bean** — not a missing import this
   time, but a missing *bean*: `@Autowired ObjectMapper` failed with "no
   qualifying bean of type `com.fasterxml.jackson.databind.ObjectMapper`."
   Spring Boot 4's own `JacksonAutoConfiguration`
   (`org.springframework.boot.jackson.autoconfigure`) now configures a
   *different* Jackson major version — the new `tools.jackson.core`
   (Jackson 3.x) line, not the classic `com.fasterxml.jackson.core`
   (Jackson 2.x) one. The classic type was still on the classpath
   (transitively, via `jjwt-jackson`'s runtime dependency) and importable —
   it just was never registered as a bean under the new default.
3. **`UserDetailsServiceAutoConfiguration`** — same story as #1. Old import
   (`org.springframework.boot.autoconfigure.security.servlet`) gone. Real
   location: `org.springframework.boot.security.autoconfigure`.

## The actual pattern (not three unrelated bugs)

Spring Boot 4 didn't remove any of these classes — it moved essentially
every `*AutoConfiguration` class out of the old monolithic
`spring-boot-autoconfigure` module and into a dedicated per-concern module
(`spring-boot-jackson`, `spring-boot-security`, `spring-boot-webmvc-test`,
...), matching the new split-starter architecture (`masterdoc/decisions.md`
#3/#4 — starters splitting into `-test` companion modules is the same
restructuring). Once you've hit this once, expect it for *any* Boot-3-era
`*AutoConfiguration` import that stops resolving after this jump — it's a
standing fact about this version, not a one-off gotcha per class.

## The technique that actually finds the new location

Guessing the new package name rarely works (three different new package
roots across three classes: `webmvc.test`, `jackson`, `security` — no single
predictable pattern). What works every time: grep the actual jars in the
local Maven repo for the class file itself.

```sh
find ~/.m2/repository -iname "*.jar" 2>/dev/null | \
  xargs -I{} sh -c 'unzip -l "{}" 2>/dev/null | grep -q "SomeClass.class$" && echo {}' 2>/dev/null | \
  grep -v sources
```

Then `unzip -l <that jar>` to read the exact package path off the `.class`
file's own path inside the archive. This is strictly more reliable than any
web search or changelog skim — it's asking the actual artifact that will be
on the classpath, not a document that might be describing a different
version.
