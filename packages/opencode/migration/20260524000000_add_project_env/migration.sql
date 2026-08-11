-- Custom migration: Add env column to project table
ALTER TABLE `project` ADD `env` text;
