-- CreateTable
CREATE TABLE "CacheStat" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "lookups" INTEGER NOT NULL DEFAULT 0,
    "exactHits" INTEGER NOT NULL DEFAULT 0,
    "similarHits" INTEGER NOT NULL DEFAULT 0,
    "misses" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BuildCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "promptKey" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "summary" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "similarHits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_BuildCache" ("createdAt", "hits", "id", "output", "prompt", "promptKey", "summary", "updatedAt") SELECT "createdAt", "hits", "id", "output", "prompt", "promptKey", "summary", "updatedAt" FROM "BuildCache";
DROP TABLE "BuildCache";
ALTER TABLE "new_BuildCache" RENAME TO "BuildCache";
CREATE UNIQUE INDEX "BuildCache_promptKey_key" ON "BuildCache"("promptKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
