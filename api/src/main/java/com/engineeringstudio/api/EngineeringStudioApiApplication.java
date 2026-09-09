package com.engineeringstudio.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.security.autoconfigure.UserDetailsServiceAutoConfiguration;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * @ConfigurationPropertiesScan finds every @ConfigurationProperties class
 * on the classpath (currently just JwtProperties) and registers it as a
 * bean automatically — one annotation here instead of an
 * @EnableConfigurationProperties(SomeProperties.class) list that has to be
 * remembered and updated every time a new properties class is added.
 *
 * UserDetailsServiceAutoConfiguration is explicitly excluded: with no
 * UserDetailsService bean of our own (see decisions.md #6d — auth doesn't
 * go through AuthenticationManager here, JwtAuthFilter handles it), Spring
 * Boot's default behavior is to fall back to a throwaway in-memory user
 * with a randomly generated password, logged at startup. It's inert —
 * nothing in SecurityConfig's filter chain ever consults it — but it's
 * confusing noise to see in logs for a bean the app never uses, so it's
 * switched off rather than left as an unexplained warning.
 */
@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)
@ConfigurationPropertiesScan
public class EngineeringStudioApiApplication {

	public static void main(String[] args) {
		SpringApplication.run(EngineeringStudioApiApplication.class, args);
	}

}
