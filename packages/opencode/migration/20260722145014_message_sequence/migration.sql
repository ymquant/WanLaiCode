-- Drizzle 会把整批迁移包在事务中，事务内无法关闭外键；原表加列可避免重建 message 时级联删除 part。
ALTER TABLE `message` ADD `sequence` integer NOT NULL DEFAULT 0;--> statement-breakpoint
-- 旧表 rowid 记录首次 INSERT 顺序；同 ID 的流式 UPDATE 不会改变它，比毫秒时间和消息 ID 更接近官方 turn.items。
WITH `ranked_message` AS (
	SELECT
		`id`,
		ROW_NUMBER() OVER (PARTITION BY `session_id` ORDER BY `rowid`) - 1 AS `sequence`
	FROM `message`
)
UPDATE `message`
SET `sequence` = (
	SELECT `ranked_message`.`sequence`
	FROM `ranked_message`
	WHERE `ranked_message`.`id` = `message`.`id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `message_session_sequence_idx` ON `message` (`session_id`,`sequence`);
