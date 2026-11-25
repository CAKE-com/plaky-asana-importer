ALTER TABLE `entity_mappings` ADD `created_plaky_id` integer;--> statement-breakpoint
-- An item mapping is scoped by its board (the Asana board id), so a task on two boards has a mapping on each (LOAD-04). A legacy row
-- (scope '') goes to the one board it can belong to: a project board for an item, a subtask entry for a subitem, on the Plaky board it was
-- committed on; one never committed goes to the only board of its kind the migration has, and stays '' when there are several.
UPDATE `entity_mappings` SET `scope` = (
  SELECT `mb`.`asana_board_id` FROM `migration_boards` `mb`
  WHERE `mb`.`migration_id` = `entity_mappings`.`migration_id`
    AND ((`entity_mappings`.`entity_type` = 'item' AND `mb`.`subitems_of` IS NULL) OR (`entity_mappings`.`entity_type` = 'subitem' AND `mb`.`subitems_of` IS NOT NULL))
    AND (`mb`.`plaky_board_id` = `entity_mappings`.`plaky_parent_id` OR (`entity_mappings`.`plaky_parent_id` IS NULL AND `mb`.`plaky_board_id` IS NOT NULL))
)
WHERE `entity_type` IN ('item', 'subitem') AND `scope` = '' AND (
  SELECT count(*) FROM `migration_boards` `mb`
  WHERE `mb`.`migration_id` = `entity_mappings`.`migration_id`
    AND ((`entity_mappings`.`entity_type` = 'item' AND `mb`.`subitems_of` IS NULL) OR (`entity_mappings`.`entity_type` = 'subitem' AND `mb`.`subitems_of` IS NOT NULL))
    AND (`mb`.`plaky_board_id` = `entity_mappings`.`plaky_parent_id` OR (`entity_mappings`.`plaky_parent_id` IS NULL AND `mb`.`plaky_board_id` IS NOT NULL))
) = 1;
