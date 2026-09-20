CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER);
INSERT INTO providers VALUES
  ('test-claude-1','claude','TestClaude','{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test-claude","ANTHROPIC_BASE_URL":"http://127.0.0.1:4789/anthropic","ANTHROPIC_DEFAULT_OPUS_MODEL_NAME":"claude-test-model"}}',1),
  ('test-codex-1','codex','TestOpenAI','{"auth":{"OPENAI_API_KEY":"sk-test-openai"},"config":"model = \"gpt-test\"\nbase_url = \"http://127.0.0.1:4789\""}',0),
  ('codex-official','codex','OpenAI Official','{"auth":{},"config":""}',0);
