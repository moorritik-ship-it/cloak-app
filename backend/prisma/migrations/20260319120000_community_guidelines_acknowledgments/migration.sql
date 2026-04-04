-- CreateTable
CREATE TABLE "public"."community_guidelines_acknowledgments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "acknowledged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_guidelines_acknowledgments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "community_guidelines_acknowledgments_user_id_idx" ON "public"."community_guidelines_acknowledgments"("user_id");

-- CreateIndex
CREATE INDEX "community_guidelines_acknowledgments_acknowledged_at_idx" ON "public"."community_guidelines_acknowledgments"("acknowledged_at");

-- AddForeignKey
ALTER TABLE "public"."community_guidelines_acknowledgments" ADD CONSTRAINT "community_guidelines_acknowledgments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
