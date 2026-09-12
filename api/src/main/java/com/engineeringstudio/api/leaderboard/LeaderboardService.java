package com.engineeringstudio.api.leaderboard;

import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.leaderboard.dto.LeaderboardEntryResponse;
import com.engineeringstudio.api.leaderboard.dto.MyLeaderboardStandingResponse;
import com.engineeringstudio.api.progress.ProblemProgressLeaderboardStats;
import com.engineeringstudio.api.progress.ProblemProgressRepository;
import com.engineeringstudio.api.progress.ProblemProgressUpgradedEvent;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Redis is treated as a pure, disposable projection of `problem_progress`
 * — never the source of truth, never written to incrementally (no
 * ZINCRBY anywhere in this class). Every write here is "read this one
 * user's current totals from Postgres, then SET (ZADD, which overwrites)
 * their membership in all three ZSETs to match" — see decisions.md for
 * why that's simpler and safer than trying to apply a delta directly to
 * Redis. That also means every method below can run zero, one, or a
 * hundred times for the same input with the same end result — there's no
 * "already applied this update" state to track.
 *
 * <p>No `@Transactional` anywhere in this class deliberately: the
 * Postgres reads go through {@link ProblemProgressRepository}, whose
 * query methods are already self-transactional (Spring Data JPA wraps
 * every repository method in its own transaction if none is already
 * open) — wrapping them again here would add nothing. The Redis writes
 * that follow aren't a JPA resource at all, so no Spring
 * `PlatformTransactionManager` could ever cover both in one atomic unit
 * anyway.
 */
@Service
public class LeaderboardService {

    private final StringRedisTemplate redisTemplate;
    private final ProblemProgressRepository problemProgressRepository;
    private final UserRepository userRepository;

    public LeaderboardService(
            StringRedisTemplate redisTemplate,
            ProblemProgressRepository problemProgressRepository,
            UserRepository userRepository) {
        this.redisTemplate = redisTemplate;
        this.problemProgressRepository = problemProgressRepository;
        this.userRepository = userRepository;
    }

    /**
     * Fires only once the transaction that produced the upgrade has
     * actually committed — see decisions.md for why AFTER_COMMIT, not the
     * default (immediate, in-transaction) phase. If this event was ever
     * published with no transaction active at all, Spring would silently
     * drop it (`@TransactionalEventListener`'s default
     * `fallbackExecution = false`) — never a concern here, since
     * ProblemProgressService.recordOutcome (the only publisher) is itself
     * always called from within an open `@Transactional` method.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onProgressUpgraded(ProblemProgressUpgradedEvent event) {
        refreshUser(event.userId());
    }

    /** Recomputes one user's aggregate stats from Postgres and overwrites their membership in all three ZSETs to match. Safe to call for any reason, any number of times — see class Javadoc. */
    public void refreshUser(UUID userId) {
        ProblemProgressLeaderboardStats stats = problemProgressRepository.aggregateLeaderboardStats(userId);
        String member = userId.toString();

        if (stats.getSolvedCount() == 0) {
            removeFromAllBoards(member);
            return;
        }

        ZSetOperations<String, String> zSetOps = redisTemplate.opsForZSet();
        zSetOps.add(LeaderboardType.MOST_SOLVED.redisKey(), member, stats.getSolvedCount());
        zSetOps.add(LeaderboardType.BEST_SOLVED.redisKey(), member, stats.getTotalPoints());
        // avgSpeedFactor can't be null here: the query this stats object
        // came from filters to rows where bestSpeedFactor IS NOT NULL, so
        // solvedCount > 0 guarantees at least one non-null value for AVG
        // to average.
        zSetOps.add(LeaderboardType.FASTEST_SOLVED.redisKey(), member, stats.getAvgSpeedFactor());
    }

    /**
     * Wipes and repopulates every board from Postgres, one user at a
     * time. Exists to make the "Redis is a disposable, rebuildable
     * projection" claim above something this project can actually
     * demonstrate and recover with (a flushed/expired Redis instance,
     * a bug in a past refresh, local dev pointed at a fresh Redis) rather
     * than just asserted — wired up as `POST /admin/leaderboard/rebuild`.
     */
    public void rebuildAll() {
        problemProgressRepository.findDistinctUserIdsWithLeaderboardEligibleSolves()
                .forEach(this::refreshUser);
    }

    /** Top `limit` entries for one board, ranked 1..limit, richest score first. */
    public List<LeaderboardEntryResponse> topN(LeaderboardType type, int limit) {
        Set<ZSetOperations.TypedTuple<String>> tuples =
                redisTemplate.opsForZSet().reverseRangeWithScores(type.redisKey(), 0, limit - 1);
        if (tuples == null || tuples.isEmpty()) {
            return List.of();
        }

        List<UUID> userIds = tuples.stream()
                .map(tuple -> UUID.fromString(tuple.getValue()))
                .toList();
        Map<UUID, String> displayNamesById = userRepository.findAllById(userIds).stream()
                .collect(Collectors.toMap(User::getId, User::getDisplayName));

        List<LeaderboardEntryResponse> entries = new ArrayList<>(tuples.size());
        int rank = 1;
        // reverseRangeWithScores preserves ZSET order (highest score
        // first) in the Set it returns — Spring Data Redis builds it as a
        // LinkedHashSet specifically to keep that guarantee, so iterating
        // it directly and assigning ranks 1..N in order is safe.
        for (ZSetOperations.TypedTuple<String> tuple : tuples) {
            UUID userId = UUID.fromString(tuple.getValue());
            entries.add(new LeaderboardEntryResponse(
                    rank++, userId, displayNamesById.getOrDefault(userId, "Unknown"), tuple.getScore()));
        }
        return entries;
    }

    /** The calling user's own rank/score on one board — `ranked = false` (not an error) if they have no qualifying solve yet. */
    public MyLeaderboardStandingResponse myStanding(LeaderboardType type, UUID userId) {
        String member = userId.toString();
        Long zeroBasedRank = redisTemplate.opsForZSet().reverseRank(type.redisKey(), member);
        if (zeroBasedRank == null) {
            return new MyLeaderboardStandingResponse(type, false, null, null);
        }
        Double score = redisTemplate.opsForZSet().score(type.redisKey(), member);
        return new MyLeaderboardStandingResponse(type, true, (int) (zeroBasedRank + 1), score);
    }

    private void removeFromAllBoards(String member) {
        for (LeaderboardType type : LeaderboardType.values()) {
            redisTemplate.opsForZSet().remove(type.redisKey(), member);
        }
    }
}
