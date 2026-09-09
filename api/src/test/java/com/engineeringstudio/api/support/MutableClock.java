package com.engineeringstudio.api.support;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicReference;

/**
 * A Clock test code can advance deterministically between calls
 * (`clock.advance(Duration.ofMinutes(2))`), instead of the test sleeping
 * on the real wall clock to prove elapsed-time math — every production
 * service already takes `Clock` as a constructor parameter specifically so
 * this is possible (see AppConfig's `clock()` bean Javadoc). Overridden as
 * `@Primary` in a test-only @TestConfiguration wherever a test needs it.
 */
public class MutableClock extends Clock {

    private final AtomicReference<Instant> instant;
    private final ZoneId zone;

    private MutableClock(Instant initial, ZoneId zone) {
        this.instant = new AtomicReference<>(initial);
        this.zone = zone;
    }

    public static MutableClock startingNow() {
        return new MutableClock(Instant.now(), ZoneOffset.UTC);
    }

    public void advance(Duration duration) {
        instant.updateAndGet(current -> current.plus(duration));
    }

    @Override
    public ZoneId getZone() {
        return zone;
    }

    @Override
    public Clock withZone(ZoneId zone) {
        return new MutableClock(instant.get(), zone);
    }

    @Override
    public Instant instant() {
        return instant.get();
    }
}
