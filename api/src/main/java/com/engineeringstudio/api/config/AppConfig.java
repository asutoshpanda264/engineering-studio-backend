package com.engineeringstudio.api.config;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * General-purpose beans that don't belong to any one feature package.
 */
@Configuration
public class AppConfig {

    /**
     * java.time.Clock, not a hand-rolled wrapper — the JDK's own Clock is
     * already exactly what testability needs: `Clock.systemUTC()` in
     * production, `Clock.fixed(...)` in a test, injected everywhere real
     * code would otherwise call `Instant.now()`/`LocalDate.now()` directly.
     * Anything computing elapsed time (the attempt state machine, streaks,
     * token expiry) takes this bean instead of calling `.now()` itself, so
     * tests can pin "now" instead of racing the real clock.
     */
    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }

    /**
     * BCrypt over a faster hash (SHA-256, etc.) specifically because it's
     * deliberately slow and salts automatically — the property you want for
     * password storage (resist brute-forcing) is the opposite of what you
     * want for e.g. refresh-token hashing (SHA-256, in RefreshToken — fast
     * lookup by hash, not resistance to guessing, since the token itself is
     * already high-entropy random data, unlike a human-chosen password).
     */
    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
