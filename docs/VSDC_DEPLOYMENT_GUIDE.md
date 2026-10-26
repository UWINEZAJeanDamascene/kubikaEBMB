# VSDC Deployment Guide

## Table of Contents

- [Section 1: Prerequisites](#section-1-prerequisites)
- [Section 2: Java and Tomcat Installation](#section-2-java-and-tomcat-installation)
- [Section 3: VSDC WAR Deployment](#section-3-vsdc-war-deployment)
- [Section 4: Device Initialization Through the System](#section-4-device-initialization-through-the-system)
- [Section 5: Code Data Sync](#section-5-code-data-sync)
- [Section 6: Branch Registration](#section-6-branch-registration)
- [Section 7: Product Registration](#section-7-product-registration)
- [Section 8: Go-Live Checklist](#section-8-go-live-checklist)
- [Section 9: Switching from Sandbox to Production](#section-9-switching-from-sandbox-to-production)

## Section 1: Prerequisites

Before deploying VSDC for a tenant, confirm all items below are complete.

- The client is VAT-registered with RRA.
- The client has an active MyRRA account.
- The client has applied for VSDC certification and received approval from RRA at `cis_sdc_certification@rra.gov.rw`.
- The server has Java JDK 11 or higher installed.
- The server has Apache Tomcat installed and running.
- RRA has provided the VSDC WAR file for the correct environment, either sandbox or production.
- The backend environment has `EBM_MODE` and `VSDC_BASE_URL` configured.
- The tenant company record has the correct TIN.
- Each operating branch or warehouse has the correct RRA branch ID.

Verify the prerequisites as follows.

1. Ask the client for the RRA VAT registration confirmation and MyRRA login confirmation.
2. Confirm RRA approval email was received from `cis_sdc_certification@rra.gov.rw`.
3. Confirm the VSDC WAR file name and environment with RRA before copying it to the server.
4. Check Java.

   ```bash
   java -version
   ```

5. Check Tomcat.

   ```bash
   curl -I http://localhost:8080/
   ```

6. Check the backend environment.

   ```env
   EBM_MODE=sandbox
   VSDC_BASE_URL=http://localhost:8080/vsdc
   ```

## Section 2: Java and Tomcat Installation

### Ubuntu or Linux

1. Update package indexes.

   ```bash
   sudo apt update
   ```

2. Install Java JDK 11.

   ```bash
   sudo apt install -y openjdk-11-jdk
   ```

3. Verify Java.

   ```bash
   java -version
   ```

4. Install Tomcat.

   ```bash
   sudo apt install -y tomcat9 tomcat9-admin
   ```

5. Start Tomcat.

   ```bash
   sudo systemctl start tomcat9
   ```

6. Configure Tomcat to start on reboot.

   ```bash
   sudo systemctl enable tomcat9
   ```

7. Verify Tomcat status.

   ```bash
   sudo systemctl status tomcat9
   ```

8. Verify Tomcat responds over HTTP.

   ```bash
   curl -I http://localhost:8080/
   ```

### Windows Server

1. Open PowerShell as Administrator.

2. Install Java JDK 11. This example uses Winget.

   ```powershell
   winget install EclipseAdoptium.Temurin.11.JDK
   ```

3. Verify Java.

   ```powershell
   java -version
   ```

4. Download Apache Tomcat 9 from the Apache Tomcat website and extract it to:

   ```text
   C:\Tomcat9
   ```

5. Set `JAVA_HOME`. Adjust the path to match the installed JDK folder.

   ```powershell
   setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-11" /M
   ```

6. Install Tomcat as a Windows service.

   ```powershell
   cd C:\Tomcat9\bin
   .\service.bat install Tomcat9
   ```

7. Configure Tomcat to start automatically.

   ```powershell
   .\Tomcat9.exe //US//Tomcat9 --Startup auto
   ```

8. Start Tomcat.

   ```powershell
   net start Tomcat9
   ```

9. Verify Tomcat responds.

   ```powershell
   curl.exe -I http://localhost:8080/
   ```

## Section 3: VSDC WAR Deployment

1. Stop Tomcat before changing the deployed WAR.

   Ubuntu or Linux:

   ```bash
   sudo systemctl stop tomcat9
   ```

   Windows Server:

   ```powershell
   net stop Tomcat9
   ```

2. Copy the RRA-provided VSDC WAR file into the Tomcat `webapps` directory.

   Ubuntu or Linux:

   ```bash
   sudo cp /path/to/vsdc.war /var/lib/tomcat9/webapps/vsdc.war
   ```

   Windows Server:

   ```powershell
   copy C:\Path\To\vsdc.war C:\Tomcat9\webapps\vsdc.war
   ```

3. Start Tomcat.

   Ubuntu or Linux:

   ```bash
   sudo systemctl start tomcat9
   ```

   Windows Server:

   ```powershell
   net start Tomcat9
   ```

4. Watch the Tomcat logs for deployment success.

   Ubuntu or Linux:

   ```bash
   sudo tail -f /var/log/tomcat9/catalina.out
   ```

   Windows Server:

   ```powershell
   Get-Content C:\Tomcat9\logs\catalina*.log -Tail 100
   ```

5. Confirm VSDC is reachable.

   ```bash
   curl -I http://localhost:8080/vsdc/
   ```

   A successful deployment normally returns HTTP `200`, HTTP `302`, or a VSDC application response. A failed deployment usually returns connection refused, HTTP `404`, HTTP `500`, or shows deployment errors in the Tomcat log.

6. Set the backend URL to the deployed VSDC context.

   ```env
   VSDC_BASE_URL=http://localhost:8080/vsdc
   ```

7. Restart the backend server after changing the environment.

## Section 4: Device Initialization Through the System

1. Log in as a tenant administrator.

2. Open Company Settings.

3. Open EBM Devices.

4. Click Initialize Device.

5. Fill in the required fields.

   - TIN: the tenant company TIN registered with RRA.
   - Branch ID: the RRA branch ID, usually `00` for the head office.
   - Device serial number: the serial number or identifier provided for the tenant VSDC device.

6. Submit the initialization request.

7. Confirm the device status changes to Initialized for the active mode, either sandbox or production.

8. If initialization succeeds, the system stores the device record with the current `EBM_MODE`. A sandbox device record does not count as initialized in production mode.

Common failures and resolutions:

- `EBM_DEVICE_NOT_INITIALIZED`: initialize the device before syncing codes or submitting documents.
- `EBM_TIN_MISSING`: update the company TIN and retry.
- Connection timeout: confirm Tomcat is running and `VSDC_BASE_URL` is correct.
- HTTP `404`: confirm the WAR is deployed as `vsdc.war` and the URL is `http://localhost:8080/vsdc`.
- Non-retryable VSDC rejection: confirm the WAR file and certificate belong to the tenant TIN.

## Section 5: Code Data Sync

1. Open Company Settings.

2. Open EBM Code Data.

3. Click Sync Now.

4. Wait for the sync to finish.

5. Confirm standard code classes are present, including tax types, packaging units, quantity units, and item classification codes.

6. If sync fails, check the displayed error and the backend logs.

7. Retry after fixing the device, VSDC URL, or network issue.

The scheduled code sync interval is controlled by:

```env
EBM_CODE_SYNC_INTERVAL_HOURS=24
```

## Section 6: Branch Registration

1. Open Warehouses.

2. Confirm each warehouse that represents an RRA branch has an RRA branch ID.

3. Open the branch or warehouse EBM section.

4. Register the branch with RRA.

5. Confirm the branch shows Registered status.

6. Repeat for every operating branch.

If branch registration fails:

- Confirm the branch ID is correct in RRA.
- Confirm the tenant device is initialized.
- Confirm the tenant TIN on the company record is correct.
- Check the backend log for the VSDC response.

## Section 7: Product Registration

1. Open Products.

2. Filter by EBM Unregistered.

3. Open an unregistered product.

4. Fill the EBM fields.

   - RRA tax type, for example `B` for taxable 18 percent VAT.
   - Item classification code.
   - Packaging unit.
   - Quantity unit.

5. Save the product.

6. Trigger product registration if it does not start automatically.

7. Confirm the product reaches Registered with RRA status.

8. Repeat until no products remain in the EBM Unregistered filter.

Products must be registered before they are used on sales invoices, POS sales, credit notes, GRNs, or stock movements that report to RRA.

## Section 8: Go-Live Checklist

Before the tenant starts using production, confirm every item below.

- Device status shows Initialized for production mode.
- Every branch shows Registered status.
- Every product that can be sold or moved in stock is registered with RRA.
- EBM code data sync completed within the last 24 hours.
- At least one test invoice was created and confirmed.
- The test invoice shows `ebmStatus: submitted`.
- The test invoice PDF shows an RRA receipt number, internal data, receipt signature, and QR code.
- POS receipt printing works with EBM data.
- Credit note PDF shows its own RRA certification block and original receipt number reference.
- GRN stock reporting reaches `ebmStatus: submitted`.
- EBM retry queue has zero pending, failed, or abandoned records.
- Backend logs show no repeated VSDC connection errors.

## Section 9: Switching from Sandbox to Production

Use the same application build in both environments; do not edit application source code to switch modes. Test and Production must use separate deployment configuration, VSDC WAR/service and database state. Do not point Production at a database containing test invoices or test fiscal counters.

1. Schedule a maintenance window for the Production deployment.

2. Back up the current environment using its database's approved backup procedure. Provision and configure the Production database independently rather than promoting test fiscal transactions or fiscal counters.

3. Stop the Test VSDC service only if it is being replaced in that deployment. Prefer separate Test and Production VSDC hosts/services so Test remains available.

4. Deploy the RRA Production VSDC WAR to the Production VSDC service. Do not replace the Test WAR in a shared service while Test clients still depend on it.

5. Verify the Production VSDC application starts successfully and can reach the Production RRA endpoint.

6. Configure the Production backend environment:

   ```env
   EBM_MODE=production
   VSDC_BASE_URL=http://localhost:8080/vsdc
   RRA_PRODUCTION_URL=https://api-ebm.rra.gov.rw
   ```

7. Start/restart the backend using the same released application build and the Production environment configuration. Startup validation fails if `EBM_MODE=production` has no valid `VSDC_BASE_URL`.

8. Open Company Settings, then EBM Devices.

9. Initialize the device in Production mode. Device initialization is stored with its environment; Test initialization does not count as Production initialization.

10. Trigger a full EBM code data sync.

11. Verify branches and products are correctly registered for the Production taxpayer TIN. Do not treat Test VSDC records as Production registrations.

12. Only submit a real, authorized business transaction in Production. Do not create a fabricated “test invoice” against Production.

13. Confirm the invoice reaches `ebmStatus: submitted` and that the returned fiscal identifiers belong to the Production environment.

14. Download the invoice PDF and confirm the real Production RRA receipt information is visible.

15. Review the Production EBM retry queue and readiness dashboard before releasing the deployment.
