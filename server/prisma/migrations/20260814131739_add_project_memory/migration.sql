-- CreateTable
CREATE TABLE "ProjectMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectMemory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProjectMemory_projectId_idx" ON "ProjectMemory"("projectId");

-- CreateIndex
CREATE INDEX "ProjectMemory_projectId_type_idx" ON "ProjectMemory"("projectId", "type");

-- CreateIndex
CREATE INDEX "ProjectMemory_projectId_status_idx" ON "ProjectMemory"("projectId", "status");
