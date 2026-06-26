# JBDeployEnvironment — One-Command Demo Setup

This folder contains a single script that deploys the **entire** NSE Results
Screener SRE-Agent demo into **your own** Azure subscription. You do **not** need
to create anything by hand.

## What gets created

Running the script provisions all of these (names include a unique token, e.g. `xxxxxxxxxxxxx`):

| Resource | Example name | Purpose |
|---|---|---|
| App Service + Plan (Linux, Node 20) | `app-xxxx`, `plan-xxxx` | Runs the web app |
| Application Gateway (WAF v2) | `agw-xxxx` | Public front door + firewall |
| Public IP | `pip-xxxx` | The shareable URL |
| WAF policy | `waf-xxxx` | OWASP protection |
| Virtual Network + 2 NSGs | `vnet-xxxx`, `…-snet-appgw-nsg-…`, `…-snet-app-nsg-…` | Private networking |
| Azure SQL (serverless) + DB | `sql-xxxx` / `JBDB` | Data store (Entra-only auth) |
| Azure AI Services (Foundry) + model | `nse-ai-xxxx` / `NSE_RESULTS_SCREENER_MODEL` (gpt-4o) | AI analysis |
| Application Insights + Log Analytics | `appi-xxxx`, `log-xxxx` | Telemetry |
| Action group + 2 alerts | `ag-xxxx`, `alert-appgw-unhealthy-backend`, `alert-db-connectivity-loss` | SRE Agent signals |

The app is wired to these resources automatically — the app settings point at the
exact resources that get created, so everything matches with no manual edits.

## Prerequisites (the script checks these for you)

| Tool | Install |
|---|---|
| Azure CLI (`az`) | <https://aka.ms/installazurecli> &nbsp;or&nbsp; `winget install Microsoft.AzureCLI` |
| Azure Developer CLI (`azd`) | <https://aka.ms/azd-install> &nbsp;or&nbsp; `winget install Microsoft.Azd` |
| Node.js 20 LTS (`node`) | <https://nodejs.org> &nbsp;or&nbsp; `winget install OpenJS.NodeJS.LTS` |
| Git | <https://git-scm.com/downloads> &nbsp;or&nbsp; `winget install Git.Git` |

You also need an Azure subscription where you can **create resources** and
**assign roles** (Owner or Contributor + User Access Administrator).

---

## Step-by-step: run it (Windows)

1. **Clone the repository** (skip if you already have the folder):
   - Click **Start**, type **powershell**, press **Enter**.
   - In the blue window, type:
     ```powershell
     git clone https://github.com/jvivek2k1/NSE_Results_Screener_V2.git
     cd NSE_Results_Screener_V2
     ```

2. **Allow the script to run** (one-time, for this window only):
   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   ```

3. **Run the setup script:**
   ```powershell
   .\JBDeployEnvironment\Deploy-JBEnvironment.ps1
   ```

4. **Follow the prompts:**
   - A browser opens — **sign in to Azure**.
   - Pick your **subscription** (if you have more than one).
   - Type a **Resource Group name** (press Enter for the default).
   - Type an **Azure region** (press Enter for `westus2`).

5. **Wait.** Provisioning + first deploy takes about **10–20 minutes**. Leave the
   window open.

6. **Done.** The script prints a **Public URL** like
   `http://nse-xxxx.<region>.cloudapp.azure.com`. Open it in a browser, or share
   it. (First load can take a few seconds while the serverless database resumes.)

> Tip: you can also pass answers up front and skip the prompts:
> ```powershell
> .\JBDeployEnvironment\Deploy-JBEnvironment.ps1 -ResourceGroup "RG_MyDemo" -Location "westus2"
> ```

---

## After deployment

- **Share the Public URL** the script printed. It's public — anyone with the link
  can open it. (The `*.azurewebsites.net` address is intentionally blocked; always
  use the gateway URL.)
- **SRE Agent demo:** point the Azure SRE Agent at the new resource group. The
  monitoring docs and runbook are in [`docs/`](../docs).

## Re-running / updating

The script is **safe to re-run**. `azd` is idempotent — it updates resources in
place and resumes if a previous run was interrupted.

## Tear down (delete everything)

To remove all the resources and stop incurring cost, delete the resource group:

```powershell
az group delete --name <your-resource-group-name> --yes --no-wait
```

(Or run `azd down --force --purge` from the repo root.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "az / azd / node / git NOT found" | Install the tool (table above), open a **new** PowerShell window, re-run. |
| "running scripts is disabled on this system" | Run the `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` command in step 2. |
| AI model quota error during provision | Your subscription may lack gpt-4o capacity in `eastus2`. Re-run with a different AI region: `… -AiLocation eastus` (or request quota). |
| Region rejected | Use a valid region name (e.g. `eastus2`, `westeurope`). The script lists common ones. |
| Provisioning fails partway | Fix the reported issue and **re-run the script** — it resumes safely. |
