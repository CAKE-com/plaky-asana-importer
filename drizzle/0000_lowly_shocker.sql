CREATE TABLE `asana_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `board_locks` (
	`plaky_space_id` integer NOT NULL,
	`plaky_board_id` integer NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`plaky_space_id`, `plaky_board_id`)
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`asana_account_id` text NOT NULL,
	`asana_user_id` text NOT NULL,
	`asana_time_zone` text,
	`asana_account_slug` text,
	`asana_tier` text,
	`plaky_user_id` integer NOT NULL,
	`plaky_web_base` text,
	`validated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entity_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`asana_id` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`occurrence` integer DEFAULT 0 NOT NULL,
	`plaky_id` integer,
	`plaky_parent_id` integer,
	`match_key` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_verified_at` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `em_unique` ON `entity_mappings` (`migration_id`,`entity_type`,`scope`,`asana_id`,`occurrence`);--> statement-breakpoint
CREATE INDEX `em_plaky` ON `entity_mappings` (`entity_type`,`plaky_id`);--> statement-breakpoint
CREATE INDEX `em_status` ON `entity_mappings` (`migration_id`,`status`);--> statement-breakpoint
CREATE TABLE `migration_boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_id` integer NOT NULL,
	`asana_board_id` text NOT NULL,
	`asana_board_name` text NOT NULL,
	`hierarchy_type` text DEFAULT 'classic' NOT NULL,
	`items_count` integer DEFAULT 0 NOT NULL,
	`subitems_of` text,
	`plaky_board_id` integer,
	`plaky_space_id` integer,
	`link_position` integer,
	`nested` integer DEFAULT false NOT NULL,
	`sync_groups` integer DEFAULT true NOT NULL,
	`sync_subscribers` integer DEFAULT false NOT NULL,
	`sync_comments` integer DEFAULT false NOT NULL,
	`sync_files` integer DEFAULT false NOT NULL,
	`field_map` text DEFAULT '{}' NOT NULL,
	`skip_columns` text DEFAULT '[]' NOT NULL,
	`label_map` text DEFAULT '{}' NOT NULL,
	`asana_id_field_key` text,
	`parent_title_field_key` text,
	`parent_id_field_key` text,
	`seed_group_id` integer,
	`applied` integer DEFAULT false NOT NULL,
	`synced_read_at` integer,
	`event_token` text,
	`by_hand` text DEFAULT '[]' NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mb_migration_asana` ON `migration_boards` (`migration_id`,`asana_board_id`);--> statement-breakpoint
CREATE INDEX `mb_migration_plaky` ON `migration_boards` (`migration_id`,`plaky_board_id`);--> statement-breakpoint
CREATE TABLE `migration_columns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_board_id` integer NOT NULL,
	`asana_column_id` text NOT NULL,
	`title` text NOT NULL,
	`asana_type` text NOT NULL,
	`field_name` text NOT NULL,
	`plaky_type` text,
	`reason` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`label_collisions` text DEFAULT '[]' NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`migration_board_id`) REFERENCES `migration_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mc_board_column` ON `migration_columns` (`migration_board_id`,`asana_column_id`);--> statement-breakpoint
CREATE TABLE `migration_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`migration_board_id` integer,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`level` text NOT NULL,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`migration_board_id`) REFERENCES `migration_boards`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `logs_run_id` ON `migration_logs` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `migration_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`planned_writes` integer,
	`counts` text,
	`receipt` text,
	`started_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	`heartbeat_at` integer,
	`owner_host` text,
	`owner_pid` integer,
	`owner_token` text,
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_migration` ON `migration_runs` (`migration_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `migrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`name` text NOT NULL,
	`closed_at` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`plaky_space_id` integer,
	`options` text NOT NULL,
	`people` text DEFAULT '{}' NOT NULL,
	`manifest` text,
	`readiness_ticks` text DEFAULT '[]' NOT NULL,
	`resume` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
