-- CreateTable
CREATE TABLE "System" (
    "symbol" TEXT NOT NULL,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "hasGate" BOOLEAN NOT NULL DEFAULT false,
    "gateWaypoint" TEXT,
    "gateBuilt" BOOLEAN NOT NULL DEFAULT false,
    "hopsFromHome" INTEGER,
    "reachable" BOOLEAN NOT NULL DEFAULT false,
    "isHome" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCrawledAt" TIMESTAMP(3) NOT NULL,
    "richnessRefreshedAt" TIMESTAMP(3),

    CONSTRAINT "System_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "GateEdge" (
    "id" TEXT NOT NULL,
    "fromSystem" TEXT NOT NULL,
    "toSystem" TEXT NOT NULL,
    "fromGateWp" TEXT,
    "toGateWp" TEXT,
    "builtFrom" BOOLEAN NOT NULL DEFAULT false,
    "builtTo" BOOLEAN NOT NULL DEFAULT false,
    "traversable" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GateEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemRichness" (
    "systemSym" TEXT NOT NULL,
    "marketplaceCount" INTEGER NOT NULL DEFAULT 0,
    "shipyardCount" INTEGER NOT NULL DEFAULT 0,
    "importSiteCount" INTEGER NOT NULL DEFAULT 0,
    "importGoodsTotal" INTEGER NOT NULL DEFAULT 0,
    "premiumShipTypes" TEXT[],
    "premiumShipCount" INTEGER NOT NULL DEFAULT 0,
    "sellsFueledHull" BOOLEAN NOT NULL DEFAULT false,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "detailLevel" TEXT NOT NULL DEFAULT 'counts',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemRichness_pkey" PRIMARY KEY ("systemSym")
);

-- CreateIndex
CREATE INDEX "System_reachable_idx" ON "System"("reachable");

-- CreateIndex
CREATE INDEX "System_hopsFromHome_idx" ON "System"("hopsFromHome");

-- CreateIndex
CREATE INDEX "System_lastCrawledAt_idx" ON "System"("lastCrawledAt");

-- CreateIndex
CREATE INDEX "GateEdge_fromSystem_idx" ON "GateEdge"("fromSystem");

-- CreateIndex
CREATE INDEX "GateEdge_toSystem_idx" ON "GateEdge"("toSystem");

-- CreateIndex
CREATE INDEX "GateEdge_traversable_idx" ON "GateEdge"("traversable");

-- CreateIndex
CREATE UNIQUE INDEX "GateEdge_fromSystem_toSystem_key" ON "GateEdge"("fromSystem", "toSystem");

-- CreateIndex
CREATE INDEX "SystemRichness_score_idx" ON "SystemRichness"("score");

-- AddForeignKey
ALTER TABLE "GateEdge" ADD CONSTRAINT "GateEdge_fromSystem_fkey" FOREIGN KEY ("fromSystem") REFERENCES "System"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateEdge" ADD CONSTRAINT "GateEdge_toSystem_fkey" FOREIGN KEY ("toSystem") REFERENCES "System"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemRichness" ADD CONSTRAINT "SystemRichness_systemSym_fkey" FOREIGN KEY ("systemSym") REFERENCES "System"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;
