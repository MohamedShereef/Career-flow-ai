// Test-only secrets. Real deployments set these via the platform's secret store.
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.APP_HASH_KEY ??= "test-hash-key";
process.env.TEST_DATABASE_URL ??= "postgres://postgres@localhost:5432/careerflow_test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR ??= "/tmp/careerflow-test-storage";
