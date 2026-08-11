-- 收件箱未读上线时把既有运行一律视为「已读」。
-- 上一条迁移只是把 read_at 列加上(默认 NULL),而 NULL = 未读 —— 结果是升级瞬间
-- 所有历史运行全部变成未读(实测一个日常使用的库里有 123 条),每条自动化都亮红点,
-- 用户根本无从分辨哪次是真的「刚跑完还没看」。未读只对本次升级之后产生的运行有意义。
-- status != 'running' 与 markAllRead 同一条守卫:正在跑的运行还没结果可看,提前写 read_at
-- 会让它跑完后永远不算未读(finishRun 与 markInterruptedRuns 都不清 read_at),
-- 用户再也看不到这次结果或失败。升级时另一个进程可能正跑着(serve/web/acp 共用同一个库)。
UPDATE `automation_run` SET `read_at` = COALESCE(`finished_at`, `started_at`)
WHERE `read_at` IS NULL AND `status` != 'running';
