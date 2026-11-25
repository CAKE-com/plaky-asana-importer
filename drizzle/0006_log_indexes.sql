CREATE INDEX `logs_board` ON `migration_logs` (`migration_board_id`);--> statement-breakpoint
CREATE INDEX `logs_run_code` ON `migration_logs` (`run_id`,`code`);