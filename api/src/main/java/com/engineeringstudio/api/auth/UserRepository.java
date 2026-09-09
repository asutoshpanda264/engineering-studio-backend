package com.engineeringstudio.api.auth;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Spring Data JPA generates the implementation of this interface at runtime —
 * `findByEmail` is "query derivation": Spring parses the method name and
 * builds the JPQL query from it, no SQL/JPQL string written by us. We only
 * hand-write a query when derivation can't express it.
 */
public interface UserRepository extends JpaRepository<User, UUID> {
    Optional<User> findByEmail(String email);

    boolean existsByEmail(String email);
}
