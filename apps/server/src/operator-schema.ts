// These tables live in the same transaction and organization schema as execution state.
export const operatorSchema = `
CREATE TABLE IF NOT EXISTS memberships(actor TEXT PRIMARY KEY, policy TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credential_access(credential TEXT PRIMARY KEY, enabled INTEGER NOT NULL, version TEXT);
CREATE TABLE IF NOT EXISTS operator_audit(request TEXT PRIMARY KEY, actor TEXT NOT NULL, organization TEXT NOT NULL,
 action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, stamp BIGINT NOT NULL,
 fingerprint TEXT NOT NULL, result TEXT NOT NULL, changeinfo TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_time ON operator_audit(stamp,request);
CREATE TABLE IF NOT EXISTS review_clock(runId TEXT PRIMARY KEY, stamp BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS review_time ON review_clock(stamp,runId);
CREATE TABLE IF NOT EXISTS operator_alerts(kind TEXT PRIMARY KEY, run TEXT, active INTEGER NOT NULL, stamp BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS worker_health(worker TEXT PRIMARY KEY, stamp BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS operator_runs ON runs(acceptedAt,runId);
CREATE INDEX IF NOT EXISTS operator_workflows ON runs(workflowId,revision,acceptedAt,runId);
CREATE INDEX IF NOT EXISTS operator_transitions ON transitions(runId,reason,at);`;

export const sqliteReviewClock = `
CREATE TRIGGER IF NOT EXISTS review_enter AFTER UPDATE OF state ON runs WHEN NEW.state='review' AND OLD.state<>'review'
BEGIN INSERT OR REPLACE INTO review_clock VALUES(NEW.runId,CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
CREATE TRIGGER IF NOT EXISTS review_leave AFTER UPDATE OF state ON runs WHEN OLD.state='review' AND NEW.state<>'review'
BEGIN DELETE FROM review_clock WHERE runId=NEW.runId; END;`;
export const postgresReviewClock = `
CREATE FUNCTION record_review_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='review' THEN INSERT INTO review_clock VALUES(NEW.runId,floor(extract(epoch FROM clock_timestamp())*1000)::bigint) ON CONFLICT(runId) DO UPDATE SET stamp=excluded.stamp;
 ELSIF OLD.state='review' THEN DELETE FROM review_clock WHERE runId=NEW.runId; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_review_time AFTER UPDATE OF state ON runs FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION record_review_time();`;
export const seedReviewClock =
  "INSERT INTO review_clock SELECT runId,COALESCE(startedAt,acceptedAt) FROM runs WHERE state='review' ON CONFLICT(runId) DO NOTHING";
