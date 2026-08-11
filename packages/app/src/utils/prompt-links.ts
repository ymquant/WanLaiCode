// App 继续保留原导入路径，但解析实现统一下沉到 core，确保输入框和已发送消息不会再次出现规则漂移。
export * from "@opencode-ai/core/util/prompt-link"
