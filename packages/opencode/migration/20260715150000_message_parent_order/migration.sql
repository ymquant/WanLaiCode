-- 修复旧版远控 user 与其 assistant 同毫秒落库时，哈希 ID 令 parent 排到回复之后的问题。
-- 写回 time_created 与 JSON 镜像后，历史读取、远控分页和前端继续共享 (time_created, id) 游标顺序。
UPDATE `message`
SET
	`time_created` = (
		SELECT `parent`.`time_created` + 1
		FROM `message` AS `parent`
		WHERE `parent`.`id` = json_extract(`message`.`data`, '$.parentID')
			AND `parent`.`session_id` = `message`.`session_id`
	),
	`data` = json_set(
		`message`.`data`,
		'$.time.created',
		(
			SELECT `parent`.`time_created` + 1
			FROM `message` AS `parent`
			WHERE `parent`.`id` = json_extract(`message`.`data`, '$.parentID')
				AND `parent`.`session_id` = `message`.`session_id`
		)
	)
WHERE json_extract(`message`.`data`, '$.role') = 'assistant'
	AND EXISTS (
		SELECT 1
		FROM `message` AS `parent`
		WHERE `parent`.`id` = json_extract(`message`.`data`, '$.parentID')
			AND `parent`.`session_id` = `message`.`session_id`
			AND `parent`.`time_created` >= `message`.`time_created`
	);
