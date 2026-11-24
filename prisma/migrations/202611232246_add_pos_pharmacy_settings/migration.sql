ALTER TABLE "system_settings"
ADD COLUMN IF NOT EXISTS "pos_pharmacy_settings" JSONB NOT NULL
DEFAULT '{"profile":{"pharmacyLicenseNumber":"","licenseIssuer":"","licenseExpiry":null,"responsiblePharmacistName":"","responsiblePharmacistId":"","premisesPermit":"","controlledMedicineAuthorized":false,"privacyNoticeEnabled":true},"branchRestrictions":[],"registerRestrictions":{},"reviewStatus":"draft","updatedBy":""}'::jsonb;
