-- CreateTable
CREATE TABLE "RunStats" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "totalNet" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lanesRun" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Intent" (
    "shipSym" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "good" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "buyWp" TEXT NOT NULL,
    "sellWp" TEXT NOT NULL,
    "costBasis" DOUBLE PRECISION NOT NULL,
    "extras" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Intent_pkey" PRIMARY KEY ("shipSym")
);

-- CreateTable
CREATE TABLE "StatusSnapshot" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phase" TEXT NOT NULL,
    "runNet" DOUBLE PRECISION NOT NULL,
    "credits" DOUBLE PRECISION NOT NULL,
    "gate" TEXT,
    "data" JSONB NOT NULL,

    CONSTRAINT "StatusSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "waypoint" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("waypoint")
);

-- CreateTable
CREATE TABLE "MarketHistory" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waypoint" TEXT NOT NULL,
    "good" TEXT NOT NULL,
    "purchasePrice" DOUBLE PRECISION NOT NULL,
    "sellPrice" DOUBLE PRECISION NOT NULL,
    "tradeVolume" INTEGER NOT NULL,
    "supply" TEXT NOT NULL,
    "activity" TEXT,

    CONSTRAINT "MarketHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeObservation" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shipSym" TEXT NOT NULL,
    "good" TEXT NOT NULL,
    "buyWp" TEXT NOT NULL,
    "sellWp" TEXT NOT NULL,
    "projected" DOUBLE PRECISION NOT NULL,
    "realized" DOUBLE PRECISION NOT NULL,
    "units" INTEGER NOT NULL,
    "buyPx" DOUBLE PRECISION NOT NULL,
    "sellPx" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "TradeObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MineEvent" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "shipSym" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "MineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateLevers" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "floor" DOUBLE PRECISION NOT NULL DEFAULT 1500000,
    "resume" DOUBLE PRECISION NOT NULL DEFAULT 1750000,
    "gap" DOUBLE PRECISION NOT NULL DEFAULT 250000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GateLevers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Waypoint" (
    "symbol" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Waypoint_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "FuelNode" (
    "symbol" TEXT NOT NULL,
    "systemSym" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FuelNode_pkey" PRIMARY KEY ("symbol")
);

-- CreateIndex
CREATE INDEX "StatusSnapshot_createdAt_idx" ON "StatusSnapshot"("createdAt");

-- CreateIndex
CREATE INDEX "MarketHistory_ts_idx" ON "MarketHistory"("ts");

-- CreateIndex
CREATE INDEX "MarketHistory_waypoint_idx" ON "MarketHistory"("waypoint");

-- CreateIndex
CREATE INDEX "MarketHistory_good_idx" ON "MarketHistory"("good");

-- CreateIndex
CREATE INDEX "TradeObservation_ts_idx" ON "TradeObservation"("ts");

-- CreateIndex
CREATE INDEX "TradeObservation_shipSym_idx" ON "TradeObservation"("shipSym");

-- CreateIndex
CREATE INDEX "MineEvent_ts_idx" ON "MineEvent"("ts");

-- CreateIndex
CREATE INDEX "MineEvent_shipSym_idx" ON "MineEvent"("shipSym");
