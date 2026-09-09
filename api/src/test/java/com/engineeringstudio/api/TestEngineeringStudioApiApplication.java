package com.engineeringstudio.api;

import org.springframework.boot.SpringApplication;

public class TestEngineeringStudioApiApplication {

	public static void main(String[] args) {
		SpringApplication.from(EngineeringStudioApiApplication::main).with(TestcontainersConfiguration.class).run(args);
	}

}
