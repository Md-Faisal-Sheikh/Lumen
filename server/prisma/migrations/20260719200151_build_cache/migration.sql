-- CreateTable
CREATE TABLE "BuildCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "promptKey" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "summary" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "BuildCache_promptKey_key" ON "BuildCache"("promptKey");
