-- 未读扫描每次轮询都跑,原索引 (archived_at, started_at) 的第二列用不上;
-- 换成 (archived_at, read_at) 以覆盖 read_at IS NULL AND archived_at IS NULL 这条判据,
-- 同时命名对齐 <table>_<column>_idx 规范。
DROP INDEX IF EXISTS `automation_run_inbox_idx`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `automation_run_archived_at_read_at_idx` ON `automation_run` (`archived_at`,`read_at`);
