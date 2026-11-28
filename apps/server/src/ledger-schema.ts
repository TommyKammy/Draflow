export const deliverySchema = `CREATE TABLE IF NOT EXISTS deliveries (
  workflowId TEXT, triggerNodeId TEXT, eventKey TEXT, source TEXT NOT NULL, expiresAt INTEGER NOT NULL,
  runId TEXT NOT NULL REFERENCES runs(runId), PRIMARY KEY(workflowId, triggerNodeId, eventKey, source)
);`;

// Keep the last removed registration so an inactive workflow still has a comparison identity.
export const inactiveRegistrationTable = `CREATE TABLE IF NOT EXISTS inactive_registrations (
  workflowId TEXT PRIMARY KEY, registration TEXT NOT NULL
);`;
export const rememberRegistration = `INSERT INTO inactive_registrations(workflowId,registration)
  VALUES(OLD.workflowId,OLD.registration) ON CONFLICT(workflowId) DO UPDATE SET registration=excluded.registration;`;

export const temporaryWebhookTable = `CREATE TEMP TABLE testWebhooks (
          path TEXT PRIMARY KEY, workflowId TEXT NOT NULL, revision INTEGER NOT NULL,
          triggerNodeId TEXT NOT NULL, expiresAt INTEGER NOT NULL, document TEXT NOT NULL
        );`;

export const ledgerTables = `CREATE TABLE IF NOT EXISTS publications (
          workflowId TEXT, revision INTEGER, document TEXT NOT NULL,
          PRIMARY KEY(workflowId, revision)
        );
        CREATE TABLE IF NOT EXISTS active (
          workflowId TEXT PRIMARY KEY, revision INTEGER NOT NULL,
          FOREIGN KEY(workflowId, revision) REFERENCES publications
        );
        CREATE TABLE IF NOT EXISTS schedules (
          workflowId TEXT NOT NULL REFERENCES active(workflowId) ON DELETE CASCADE,
          triggerNodeId TEXT NOT NULL, spec TEXT NOT NULL, nextAt INTEGER NOT NULL,
          PRIMARY KEY(workflowId,triggerNodeId)
        );
        CREATE INDEX IF NOT EXISTS scheduleDue ON schedules(nextAt);
        CREATE TABLE IF NOT EXISTS webhookRoutes (
          path TEXT PRIMARY KEY, workflowId TEXT NOT NULL REFERENCES active(workflowId) ON DELETE CASCADE,
          triggerNodeId TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS webhookTestDocuments (workflowId TEXT PRIMARY KEY);
        ${temporaryWebhookTable}
        CREATE TABLE IF NOT EXISTS runs (
          runId TEXT NOT NULL UNIQUE, workflowId TEXT NOT NULL, revision INTEGER NOT NULL,
          triggerNodeId TEXT NOT NULL, eventKey TEXT, mode TEXT NOT NULL, payload TEXT,
          state TEXT NOT NULL, acceptedAt INTEGER NOT NULL, startedAt INTEGER, stoppedAt INTEGER, outcome TEXT,
          FOREIGN KEY(workflowId, revision) REFERENCES publications
        );
        CREATE INDEX IF NOT EXISTS queue ON runs(state);
        CREATE TABLE IF NOT EXISTS continuations (
          runId TEXT PRIMARY KEY REFERENCES runs(runId), checkpoint TEXT NOT NULL,
          token TEXT NOT NULL, mode TEXT NOT NULL, dueAt INTEGER NOT NULL, response TEXT
        );
        CREATE INDEX IF NOT EXISTS continuationDue ON continuations(dueAt) WHERE mode IN ('event','time') AND response IS NULL;
        CREATE TABLE IF NOT EXISTS effects (
          runId TEXT REFERENCES runs(runId), nodeId TEXT, visit INTEGER, item INTEGER, key TEXT UNIQUE NOT NULL,
          fingerprint TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
          PRIMARY KEY(runId,nodeId,visit,item)
        );
        CREATE TABLE IF NOT EXISTS compensationSteps (
          source TEXT PRIMARY KEY REFERENCES effects(key), root TEXT NOT NULL, priority INTEGER NOT NULL,
          workflow TEXT NOT NULL, revision INTEGER NOT NULL, auto INTEGER NOT NULL, input TEXT NOT NULL, result TEXT,
          child TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending', failure TEXT, reason TEXT);
        CREATE INDEX IF NOT EXISTS compensationRoot ON compensationSteps(root, priority);
        CREATE TABLE IF NOT EXISTS compensations(root TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS compensationRetries(failure TEXT PRIMARY KEY, root TEXT NOT NULL, attempt TEXT NOT NULL);

        CREATE TABLE IF NOT EXISTS calls (
          child TEXT PRIMARY KEY REFERENCES runs(runId), parent TEXT NOT NULL REFERENCES runs(runId),
          node TEXT NOT NULL, visit INTEGER NOT NULL, batch INTEGER NOT NULL,
          UNIQUE(parent,node,visit,batch)
        );
        CREATE TABLE IF NOT EXISTS pageRuns (
          runId TEXT REFERENCES runs(runId), node TEXT, visit INTEGER, cursor TEXT, next TEXT, rows TEXT,
          offset INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, batches INTEGER NOT NULL DEFAULT 0,
          items INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
          skipped INTEGER NOT NULL DEFAULT 0,
          error TEXT, created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retryAt INTEGER,
          PRIMARY KEY(runId,node,visit)
        );
        CREATE TABLE IF NOT EXISTS parallelWork (
          child TEXT PRIMARY KEY REFERENCES runs(runId), parent TEXT NOT NULL REFERENCES runs(runId),
          start INTEGER NOT NULL, length INTEGER NOT NULL, baseTotal REAL NOT NULL,
          status TEXT NOT NULL, failure TEXT, retryData TEXT);
        CREATE INDEX IF NOT EXISTS parallelParent ON parallelWork(parent,start);
        CREATE TABLE IF NOT EXISTS rateLimits (target TEXT PRIMARY KEY, untilMs INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS recoveryPoints (
          failure TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(runId), node TEXT NOT NULL,
          visit INTEGER NOT NULL, child TEXT, reason TEXT NOT NULL, expires INTEGER NOT NULL,
          data TEXT, attempt TEXT, accepted INTEGER, outcome TEXT
        );
        CREATE INDEX IF NOT EXISTS recoveryRun ON recoveryPoints(runId);
        CREATE INDEX IF NOT EXISTS recoveryExpiry ON recoveryPoints(expires) WHERE data IS NOT NULL;
        CREATE TABLE IF NOT EXISTS syncScopes (
          scope TEXT PRIMARY KEY, contract TEXT NOT NULL, token TEXT, candidate TEXT, owner TEXT REFERENCES runs(runId)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS syncOwner ON syncScopes(owner) WHERE owner IS NOT NULL;
        CREATE TABLE IF NOT EXISTS syncQueue (
          runId TEXT PRIMARY KEY REFERENCES runs(runId), scope TEXT NOT NULL REFERENCES syncScopes(scope)
        );
        CREATE INDEX IF NOT EXISTS syncQueueScope ON syncQueue(scope);
        CREATE TABLE IF NOT EXISTS syncVersions (
          scope TEXT, entity TEXT, version INTEGER NOT NULL, PRIMARY KEY(scope,entity)
        );
        CREATE TABLE IF NOT EXISTS syncWork (
          child TEXT, item INTEGER, scope TEXT NOT NULL, entity TEXT NOT NULL, version INTEGER NOT NULL,
          lifetime INTEGER NOT NULL, firstSend INTEGER, PRIMARY KEY(child,item)
        );


        CREATE TABLE IF NOT EXISTS canceledRuns (runId TEXT PRIMARY KEY REFERENCES runs(runId));
        CREATE TABLE IF NOT EXISTS readyAfter (runId TEXT PRIMARY KEY REFERENCES runs(runId), cutoff INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS pageRetry ON pageRuns(retryAt) WHERE retryAt IS NOT NULL;
        CREATE TABLE IF NOT EXISTS seenCursors (
          runId TEXT, node TEXT, visit INTEGER, digest TEXT, PRIMARY KEY(runId,node,visit,digest)
        );
        CREATE TABLE IF NOT EXISTS transitions (
          runId TEXT REFERENCES runs(runId), nodeId TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS transitionRun ON transitions(runId);
        ${deliverySchema}
        CREATE TABLE IF NOT EXISTS history (
          workflowId TEXT, id TEXT, status TEXT NOT NULL, startedAt INTEGER NOT NULL,
          summary TEXT NOT NULL, detail TEXT, PRIMARY KEY(workflowId, id)
        );`;

export const sqliteTriggers = `CREATE TRIGGER IF NOT EXISTS compensationApplied AFTER UPDATE OF state ON effects WHEN NEW.state='success'
        BEGIN
          UPDATE compensationSteps SET result=NEW.result WHERE source=NEW.key;
        END;
CREATE TRIGGER IF NOT EXISTS releaseSyncWork AFTER UPDATE OF data ON recoveryPoints
        WHEN OLD.data IS NOT NULL AND NEW.data IS NULL AND NEW.attempt IS NULL AND OLD.child IS NOT NULL
        BEGIN
          DELETE FROM syncWork WHERE child=OLD.child;
        END;
CREATE TRIGGER IF NOT EXISTS releaseParallelSyncWork AFTER UPDATE OF data ON recoveryPoints
        WHEN OLD.data IS NOT NULL AND NEW.data IS NULL AND NEW.attempt IS NULL
        BEGIN
          DELETE FROM syncWork WHERE child IN (SELECT json_extract(value,'$.child') FROM json_each(OLD.data,'$.wave'));
        END;
CREATE TRIGGER IF NOT EXISTS syncApplied AFTER UPDATE OF state ON effects WHEN NEW.state='success'
        BEGIN
          INSERT INTO syncVersions SELECT scope,entity,version FROM syncWork WHERE child=NEW.runId AND item=NEW.item
          ON CONFLICT(scope,entity) DO UPDATE SET version=max(version,excluded.version);
        END;`;
