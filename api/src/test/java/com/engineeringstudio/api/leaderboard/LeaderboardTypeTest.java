package com.engineeringstudio.api.leaderboard;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.engineeringstudio.api.common.error.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/** No Spring context needed — pure enum logic, same spirit as PointsCalculatorTest. */
class LeaderboardTypeTest {

    @Test
    void fromSlugRoundTripsEveryConstant() {
        for (LeaderboardType type : LeaderboardType.values()) {
            assertThat(LeaderboardType.fromSlug(type.slug())).isEqualTo(type);
        }
    }

    @Test
    void redisKeyIsNamespacedByLeaderboardPrefix() {
        assertThat(LeaderboardType.MOST_SOLVED.redisKey()).isEqualTo("leaderboard:most-solved");
        assertThat(LeaderboardType.BEST_SOLVED.redisKey()).isEqualTo("leaderboard:best-solved");
        assertThat(LeaderboardType.FASTEST_SOLVED.redisKey()).isEqualTo("leaderboard:fastest-solved");
    }

    @Test
    void unknownSlugThrowsA400ApiException() {
        assertThatThrownBy(() -> LeaderboardType.fromSlug("nonsense"))
                .isInstanceOf(ApiException.class)
                .satisfies(ex -> assertThat(((ApiException) ex).getStatus()).isEqualTo(HttpStatus.BAD_REQUEST));
    }
}
