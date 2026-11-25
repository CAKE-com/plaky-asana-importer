CREATE TABLE `written_values` (
	`migration_id` integer NOT NULL,
	`plaky_board_id` integer NOT NULL,
	`subject` text NOT NULL,
	`key` text NOT NULL,
	`hash` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`migration_id`, `plaky_board_id`, `subject`, `key`),
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
