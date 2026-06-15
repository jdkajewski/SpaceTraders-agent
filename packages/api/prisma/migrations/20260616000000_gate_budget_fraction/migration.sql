-- AlterTable: add live-tunable gate budget fraction lever (default 0.8 = 80% of growth budget)
ALTER TABLE "GateLevers" ADD COLUMN "budgetFraction" DOUBLE PRECISION NOT NULL DEFAULT 0.8;
