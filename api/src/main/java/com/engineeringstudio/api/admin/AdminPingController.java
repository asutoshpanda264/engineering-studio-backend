package com.engineeringstudio.api.admin;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * M1's throwaway proof that @PreAuthorize actually works end-to-end
 * (a USER token gets 403, an ADMIN token gets 200) — replaced by real
 * admin endpoints (user/role management) in a later milestone. Kept
 * deliberately trivial: its only job is being the RBAC smoke test.
 */
@RestController
public class AdminPingController {

    @GetMapping("/admin/ping")
    @PreAuthorize("hasRole('ADMIN')")
    public String ping() {
        return "pong";
    }
}
