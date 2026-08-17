-- Project: the runtime that executes this project's code, plus the fields that
-- make a project shareable as a starting point rather than only as a link.
ALTER TABLE "Project" ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'web';
ALTER TABLE "Project" ADD COLUMN "isTemplate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "description" TEXT;
ALTER TABLE "Project" ADD COLUMN "forkCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Project" ADD COLUMN "forkedFromId" TEXT;
ALTER TABLE "Project" ADD COLUMN "forkedFromName" TEXT;

-- CreateIndex
CREATE INDEX "Project_isTemplate_updatedAt_idx" ON "Project"("isTemplate", "updatedAt");

-- Publication: listing in the gallery is opt-in and separate from publishing.
-- Existing publications were made under the unlisted-by-link contract, so the
-- default of false is what keeps this migration from changing their visibility.
ALTER TABLE "Publication" ADD COLUMN "listed" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Publication_listed_updatedAt_idx" ON "Publication"("listed", "updatedAt");

-- BuildCache: the key gains the runtime, so a Python build and a web build of
-- the same words are separate entries. Existing rows predate the Python runtime
-- and are all web builds, which is exactly what the default backfills.
ALTER TABLE "BuildCache" ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'web';

-- DropIndex
DROP INDEX "BuildCache_promptKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "BuildCache_promptKey_runtime_key" ON "BuildCache"("promptKey", "runtime");
