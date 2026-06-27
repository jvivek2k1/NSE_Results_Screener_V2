<#
.SYNOPSIS
    One-command deployment for the NSE Results Screener SRE-Agent demo.

.DESCRIPTION
    Provisions every Azure resource the app needs (App Service + Application
    Gateway/WAF + VNet + Azure SQL + Application Insights/Log Analytics + alerts
    + Azure AI Services/Foundry with a gpt-4o deployment) and deploys the app
    code — all from a single script.

    It will:
      1. Verify prerequisites (Azure CLI, Azure Developer CLI, Node.js, Git).
      2. Sign you in to Azure (browser).
      3. Let you pick a subscription, then ask for a Resource Group name + region.
      4. Create the resource group.
      5. Provision all infrastructure and deploy the app (azd up).
      6. Print the public URL to share.

.NOTES
    Run from anywhere — the script locates the repo root automatically.
    Safe to re-run: azd is idempotent and will update in place.
#>

[CmdletBinding()]
param(
    [string] $ResourceGroup,
    [string] $Location,
    [string] $SubscriptionId,
    [string] $AiLocation = 'eastus2'
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    [!]  $msg" -ForegroundColor Yellow }
function Fail($msg)        { Write-Host "`n[X] $msg" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------
# Helpers: permission + quota pre-flight checks.
# ------------------------------------------------------------------
function Test-RequiredPrivileges {
    param([string] $SubId, [string] $PrincipalId)

    $scope = "/subscriptions/$SubId"

    # 1) Authoritative: ask ARM whether *I* can create resources and assign roles.
    try {
        $payload = @{
            Subject = @{ Attributes = @{ ObjectId = $PrincipalId } }
            Actions = @(
                @{ Id = 'Microsoft.Authorization/roleAssignments/write' },
                @{ Id = 'Microsoft.Resources/subscriptions/resourceGroups/write' }
            )
        } | ConvertTo-Json -Depth 6
        $tmp = New-TemporaryFile
        Set-Content -Path $tmp.FullName -Value $payload -Encoding utf8
        $uri  = "https://management.azure.com$scope/providers/Microsoft.Authorization/checkAccess?api-version=2018-09-01-preview"
        $resp = az rest --method post --uri $uri --body "@$($tmp.FullName)" --headers "Content-Type=application/json" -o json 2>$null | ConvertFrom-Json
        Remove-Item $tmp.FullName -ErrorAction SilentlyContinue
        $decisions = @()
        if     ($resp -is [System.Array]) { $decisions = $resp }
        elseif ($resp.value)              { $decisions = $resp.value }
        elseif ($resp.accessDecisions)    { $decisions = $resp.accessDecisions }
        elseif ($resp.accessDecision)     { $decisions = @($resp) }
        if ($decisions.Count -gt 0) {
            $denied = $decisions | Where-Object { "$($_.accessDecision)" -ne 'Allowed' }
            if ($denied) { return @{ State = 'denied'; Roles = @() } }
            return @{ State = 'allowed'; Roles = @() }
        }
    } catch { }

    # 2) Fallback: inspect role assignments (incl. inherited + group-based).
    $rolesRaw = az role assignment list --assignee $PrincipalId --scope $scope `
                    --include-inherited --include-groups `
                    --query "[].roleDefinitionName" -o tsv 2>$null
    if ($LASTEXITCODE -ne 0) { return @{ State = 'unknown'; Roles = @() } }
    $roles = @($rolesRaw -split "`r?`n" | Where-Object { $_ })
    if ($roles.Count -eq 0) { return @{ State = 'unknown'; Roles = @() } }

    $isOwner   = $roles -contains 'Owner'
    $isContrib = $roles -contains 'Contributor'
    $canAssign = ($roles -contains 'User Access Administrator') -or ($roles -contains 'Role Based Access Control Administrator')
    if ($isOwner -or ($isContrib -and $canAssign)) { return @{ State = 'allowed'; Roles = $roles } }
    return @{ State = 'denied'; Roles = $roles }
}

function Get-Gpt4oQuotaFree {
    param([string] $Region)
    $usages = az cognitiveservices usage list --location $Region -o json 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $usages) { return $null }  # unknown / not readable
    $u = $usages | Where-Object { $_.name.value -eq 'OpenAI.GlobalStandard.gpt-4o' }
    if (-not $u) { return 0 }
    return [int][math]::Floor([double]$u.limit - [double]$u.currentValue)
}

# ------------------------------------------------------------------
# 0. Locate the repo root (the folder that contains azure.yaml).
# ------------------------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
if (-not (Test-Path (Join-Path $repoRoot 'azure.yaml'))) {
    Fail "Could not find azure.yaml. Run this script from inside the cloned repo (JBDeployEnvironment folder)."
}
Set-Location $repoRoot
Write-Host "Repo root: $repoRoot" -ForegroundColor DarkGray

Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "   NSE Results Screener - SRE Agent Demo : Environment Setup " -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta

# ------------------------------------------------------------------
# 1. Prerequisite checks.
# ------------------------------------------------------------------
Write-Step "Checking prerequisites"

function Test-Tool($name, $cmd, $installHint) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        Write-Ok "$name found"
        return $true
    }
    Write-Warn2 "$name NOT found. $installHint"
    return $false
}

$missing = $false
if (-not (Test-Tool 'Azure CLI (az)'        'az'   'Install: https://aka.ms/installazurecli  (or: winget install Microsoft.AzureCLI)'))            { $missing = $true }
if (-not (Test-Tool 'Azure Developer CLI'   'azd'  'Install: https://aka.ms/azd-install      (or: winget install Microsoft.Azd)'))                 { $missing = $true }
if (-not (Test-Tool 'Node.js (node)'        'node' 'Install Node 20 LTS: https://nodejs.org  (or: winget install OpenJS.NodeJS.LTS)'))              { $missing = $true }
if (-not (Test-Tool 'Git'                   'git'  'Install: https://git-scm.com/downloads   (or: winget install Git.Git)'))                        { $missing = $true }

if ($missing) {
    Fail "Install the missing tool(s) above, open a NEW terminal, and re-run this script."
}

# ------------------------------------------------------------------
# 2. Sign in to Azure (both az and azd).
# ------------------------------------------------------------------
Write-Step "Signing in to Azure"

$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "    Opening browser for Azure CLI sign-in..." -ForegroundColor DarkGray
    az login --only-show-errors | Out-Null
    $account = az account show 2>$null | ConvertFrom-Json
}
if (-not $account) { Fail "Azure CLI sign-in failed." }
Write-Ok "Signed in as $($account.user.name)"

# azd uses its own auth context.
$azdLogin = azd auth login --check-status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "    Opening browser for Azure Developer CLI sign-in..." -ForegroundColor DarkGray
    azd auth login | Out-Null
}
Write-Ok "Azure Developer CLI authenticated"

# Disable azd's per-invocation update check. Its network call can intermittently
# hang (e.g. on restricted/proxied networks), which would silently stall the
# `azd env set` / `azd up` steps below since their output is suppressed.
azd config set defaults.update-check false 2>$null | Out-Null

# ------------------------------------------------------------------
# 3. Select subscription.
# ------------------------------------------------------------------
Write-Step "Selecting subscription"

if (-not $SubscriptionId) {
    $subs = az account list --query "[?state=='Enabled'].{name:name, id:id}" -o json | ConvertFrom-Json
    if (-not $subs -or $subs.Count -eq 0) { Fail "No enabled subscriptions found for this account." }

    if ($subs.Count -eq 1) {
        $SubscriptionId = $subs[0].id
        Write-Ok "Using the only subscription: $($subs[0].name)"
    }
    else {
        Write-Host ""
        for ($i = 0; $i -lt $subs.Count; $i++) {
            Write-Host ("    [{0}] {1}  ({2})" -f ($i + 1), $subs[$i].name, $subs[$i].id)
        }
        $pick = Read-Host "`n    Enter the number of the subscription to use"
        $idx = [int]$pick - 1
        if ($idx -lt 0 -or $idx -ge $subs.Count) { Fail "Invalid subscription selection." }
        $SubscriptionId = $subs[$idx].id
    }
}
az account set --subscription $SubscriptionId
$sub = az account show -o json | ConvertFrom-Json
Write-Ok "Subscription: $($sub.name) ($($sub.id))"

# ------------------------------------------------------------------
# 3b. Verify the signed-in user can create resources AND assign roles.
# ------------------------------------------------------------------
Write-Step "Verifying your permissions on this subscription"

$principalId   = az ad signed-in-user show --query id -o tsv
$principalName = az ad signed-in-user show --query userPrincipalName -o tsv
if ([string]::IsNullOrWhiteSpace($principalName)) {
    $principalName = az ad signed-in-user show --query mail -o tsv
}

$priv = Test-RequiredPrivileges -SubId $SubscriptionId -PrincipalId $principalId
switch ($priv.State) {
    'allowed' {
        Write-Ok "Permission check passed (can create resources and assign roles)"
    }
    'denied' {
        if ($priv.Roles.Count -gt 0) { Write-Warn2 ("Your roles here: {0}" -f ($priv.Roles -join ', ')) }
        Fail @"
Your account does NOT have the permissions required to deploy this app on
subscription '$($sub.name)'.

This deployment must create resources AND assign managed-identity roles
(for SQL and Azure OpenAI), so your account needs ONE of the following at the
subscription scope:
  * Owner, OR
  * Contributor + User Access Administrator
    (or Contributor + 'Role Based Access Control Administrator')

Ask your Azure administrator to grant one of the above, then re-run this script.
"@
    }
    default {
        Write-Warn2 "Could not automatically verify your permissions (directory/API access is limited)."
        $ans = Read-Host "    Continue anyway? You MUST have Owner, or Contributor + User Access Administrator. [y/N]"
        if ($ans -notmatch '^(y|yes)$') { Fail "Aborted. Re-run after confirming you have the required permissions." }
    }
}

# ------------------------------------------------------------------
# 4. Prompt for Resource Group name + region.
# ------------------------------------------------------------------
Write-Step "Deployment target"

if (-not $ResourceGroup) {
    $ResourceGroup = Read-Host "    Resource Group name to create [RG_JB_NSE_RESULTS_SCREENER]"
    if ([string]::IsNullOrWhiteSpace($ResourceGroup)) { $ResourceGroup = 'RG_JB_NSE_RESULTS_SCREENER' }
}

if (-not $Location) {
    Write-Host "    Common regions: eastus, eastus2, westus2, westus3, centralus, northeurope, westeurope, uksouth, australiaeast, southeastasia, centralindia" -ForegroundColor DarkGray
    $Location = Read-Host "    Azure region for the app [westus2]"
    if ([string]::IsNullOrWhiteSpace($Location)) { $Location = 'westus2' }
}

# Validate the region exists.
$validRegion = az account list-locations --query "[?name=='$Location'] | [0].name" -o tsv
if (-not $validRegion) { Fail "'$Location' is not a valid Azure region for this subscription." }

# ------------------------------------------------------------------
# 4b. Ensure gpt-4o (GlobalStandard) quota exists; auto-pick a region if not.
# ------------------------------------------------------------------
Write-Step "Checking Azure OpenAI gpt-4o quota"
$neededCapacity = 10
$candidateRegions = @($AiLocation) + @(
    'eastus2','eastus','westus','westus3','northcentralus','southcentralus',
    'swedencentral','westeurope','francecentral','uksouth','japaneast','australiaeast'
) | Select-Object -Unique

$chosenAi       = $null
$primaryUnknown = $false
foreach ($r in $candidateRegions) {
    $free = Get-Gpt4oQuotaFree -Region $r
    if ($null -eq $free) {
        if ($r -eq $AiLocation) { $primaryUnknown = $true }
        Write-Warn2 "Could not read gpt-4o quota in '$r' - skipping"
        continue
    }
    if ($free -ge $neededCapacity) {
        $chosenAi = $r
        Write-Ok "gpt-4o GlobalStandard quota available in '$r' ($free units free)"
        break
    }
    Write-Warn2 "Insufficient gpt-4o quota in '$r' (only $free of $neededCapacity units free)"
}

if ($chosenAi) {
    if ($chosenAi -ne $AiLocation) {
        Write-Warn2 "Switching AI region from '$AiLocation' to '$chosenAi' (where quota is available)."
    }
    $AiLocation = $chosenAi
}
elseif ($primaryUnknown) {
    Write-Warn2 "Could not verify quota in any region; proceeding with '$AiLocation' and letting the deployment validate it."
}
else {
    Fail @"
No checked region has enough Azure OpenAI 'gpt-4o' (GlobalStandard) quota
(need $neededCapacity units).

Options:
  * Request a quota increase:  https://aka.ms/oai/quotaincrease
  * Re-run choosing a region you know has quota:  -AiLocation <region>
"@
}

Write-Ok "Resource Group : $ResourceGroup"
Write-Ok "App region     : $Location"
Write-Ok "AI region      : $AiLocation  (Foundry / gpt-4o)"

# ------------------------------------------------------------------
# 5. Create the resource group.
# ------------------------------------------------------------------
Write-Step "Creating resource group"
az group create --name $ResourceGroup --location $Location --only-show-errors | Out-Null
Write-Ok "Resource group ready: $ResourceGroup"

# ------------------------------------------------------------------
# 6. Install Node dependencies (needed by the post-provision SQL grant hook).
# ------------------------------------------------------------------
Write-Step "Installing Node dependencies (for the SQL access hook)"
if (Test-Path (Join-Path $repoRoot 'package-lock.json')) {
    npm ci --no-audit --no-fund
} else {
    npm install --no-audit --no-fund
}
Write-Ok "Dependencies installed"

# ------------------------------------------------------------------
# 7. Configure the azd environment.
# ------------------------------------------------------------------
Write-Step "Configuring the azd environment"

# A short, DNS-safe environment name derived from the resource group.
$envName = ($ResourceGroup -replace '[^a-zA-Z0-9]', '').ToLower()
if ($envName.Length -gt 24) { $envName = $envName.Substring(0, 24) }
if ([string]::IsNullOrWhiteSpace($envName)) { $envName = 'jbdemo' }

$existingEnvs = azd env list --output json 2>$null | ConvertFrom-Json
if ($existingEnvs -and ($existingEnvs.Name -contains $envName)) {
    azd env select $envName | Out-Null
    Write-Ok "Reusing existing azd environment: $envName"
} else {
    # IMPORTANT: pass --no-prompt so azd never blocks on an interactive prompt.
    # Without it, azd may prompt to pick a subscription/location, and because the
    # output is captured the prompt is invisible -> the script appears to hang.
    azd env new $envName --subscription $SubscriptionId --location $Location --no-prompt
    if ($LASTEXITCODE -ne 0) {
        Fail "azd env new failed for '$envName'. Verify the subscription ('$SubscriptionId') and location ('$Location') are valid, then re-run."
    }
    Write-Ok "Created azd environment: $envName"
}

# ------------------------------------------------------------------
# Stable resource-name token: a ddMMyyHHmmss timestamp generated ONCE per
# environment and reused on every re-run, so azd updates resources in place
# (a fresh timestamp each run would create duplicate resources). The token is
# 12 digits — short enough to keep every resource name within Azure limits.
# ------------------------------------------------------------------
$existingToken = ''
$tokenLine = (azd env get-values 2>$null) | Select-String '^RESOURCE_TOKEN='
if ($tokenLine) { $existingToken = $tokenLine.ToString() -replace '^RESOURCE_TOKEN=', '' -replace '"', '' }
if ([string]::IsNullOrWhiteSpace($existingToken)) {
    $resourceToken = Get-Date -Format 'ddMMyyHHmmss'
    azd env set RESOURCE_TOKEN $resourceToken | Out-Null
    Write-Ok "Resource-name token: $resourceToken (timestamp ddMMyyHHmmss)"
} else {
    $resourceToken = $existingToken
    Write-Ok "Reusing resource-name token: $resourceToken"
}

# Signed-in principal (already resolved during the permission check) is the Entra SQL admin.
if ([string]::IsNullOrWhiteSpace($principalId)) {
    $principalId = az ad signed-in-user show --query id -o tsv
}
if ([string]::IsNullOrWhiteSpace($principalName)) {
    $principalName = az ad signed-in-user show --query userPrincipalName -o tsv
}

azd env set AZURE_SUBSCRIPTION_ID $SubscriptionId   | Out-Null
azd env set AZURE_LOCATION        $Location          | Out-Null
azd env set AZURE_AI_LOCATION     $AiLocation        | Out-Null
azd env set AZURE_RESOURCE_GROUP  $ResourceGroup     | Out-Null
azd env set AZURE_PRINCIPAL_ID    $principalId       | Out-Null
azd env set AZURE_PRINCIPAL_NAME  $principalName     | Out-Null
azd env set AZURE_PRINCIPAL_TYPE  'User'             | Out-Null
Write-Ok "Environment configured (SQL admin: $principalName)"

# ------------------------------------------------------------------
# 7b. (Optional) Configure email-on-open notifications.
#     Non-secret values are stored as azd env vars (-> app settings).
#     The app PASSWORD is written to Key Vault AFTER provisioning; it is
#     never stored in .env or in azd's environment files.
# ------------------------------------------------------------------
Write-Step "Email notifications (optional)"

$emailEnabled       = $false
$emailPasswordPlain = $null

$ans = Read-Host "    Enable email-on-open notifications? [y/N]"
if ($ans -match '^(y|yes)$') {
    $emailEnabled = $true

    Write-Host ""
    Write-Host "    Choose your email provider:" -ForegroundColor DarkGray
    Write-Host "      [1] Yahoo             (smtp.mail.yahoo.com:465)"
    Write-Host "      [2] Gmail             (smtp.gmail.com:465)"
    Write-Host "      [3] Outlook/Hotmail   (smtp-mail.outlook.com:587)"
    Write-Host "      [4] Custom            (enter host + port manually)"
    $provider = Read-Host "    Provider [1]"
    if ([string]::IsNullOrWhiteSpace($provider)) { $provider = '1' }

    switch ($provider) {
        '1' { $emailHost = 'smtp.mail.yahoo.com';   $emailPort = '465' }
        '2' { $emailHost = 'smtp.gmail.com';        $emailPort = '465' }
        '3' { $emailHost = 'smtp-mail.outlook.com'; $emailPort = '587' }
        '4' {
            $emailHost = Read-Host "    SMTP host (e.g. smtp.example.com)"
            while ([string]::IsNullOrWhiteSpace($emailHost)) { $emailHost = Read-Host "    SMTP host is required" }
            $emailPort = Read-Host "    SMTP port [465]"
            if ([string]::IsNullOrWhiteSpace($emailPort)) { $emailPort = '465' }
        }
        default { $emailHost = 'smtp.mail.yahoo.com'; $emailPort = '465' }
    }

    $emailUser = Read-Host "    Sender email address (SMTP login user)"
    while ([string]::IsNullOrWhiteSpace($emailUser)) { $emailUser = Read-Host "    Sender email address is required" }

    $emailFrom = Read-Host "    From address [$emailUser]"
    if ([string]::IsNullOrWhiteSpace($emailFrom)) { $emailFrom = $emailUser }

    $emailTo = Read-Host "    Send notifications to [$emailUser]"
    if ([string]::IsNullOrWhiteSpace($emailTo)) { $emailTo = $emailUser }

    $emailThrottle = Read-Host "    Minimum minutes between emails [10]"
    if ([string]::IsNullOrWhiteSpace($emailThrottle)) { $emailThrottle = '10' }

    Write-Host ""
    Write-Host "    Enter the app password / SMTP password (input is hidden)." -ForegroundColor DarkGray
    Write-Host "    Note: Gmail/Yahoo/Outlook require an APP PASSWORD, not your normal login password." -ForegroundColor DarkGray
    do {
        $securePwd = Read-Host "    App password" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePwd)
        try { $emailPasswordPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    } while ([string]::IsNullOrWhiteSpace($emailPasswordPlain))

    azd env set AZURE_EMAIL_ENABLED    'true'         | Out-Null
    azd env set EMAIL_HOST             $emailHost     | Out-Null
    azd env set EMAIL_PORT             $emailPort     | Out-Null
    azd env set EMAIL_USER            $emailUser      | Out-Null
    azd env set EMAIL_FROM            $emailFrom      | Out-Null
    azd env set EMAIL_TO              $emailTo        | Out-Null
    azd env set EMAIL_THROTTLE_MINUTES $emailThrottle | Out-Null
    Write-Ok "Email configured ($emailUser via ${emailHost}:${emailPort}). Password will be stored in Key Vault."
}
else {
    azd env set AZURE_EMAIL_ENABLED 'false' | Out-Null
    Write-Ok "Email notifications disabled"
}

# ------------------------------------------------------------------
# 8. Provision + deploy.
# ------------------------------------------------------------------
Write-Step "Provisioning Azure resources and deploying the app (this can take 10-20 minutes)"
azd up --no-prompt
if ($LASTEXITCODE -ne 0) {
    Fail "azd up failed. Scroll up for the error. You can fix the issue and re-run this script (it resumes safely)."
}

# ------------------------------------------------------------------
# 8b. Store the email app password in Key Vault (if email enabled).
# ------------------------------------------------------------------
if ($emailEnabled -and $emailPasswordPlain) {
    Write-Step "Storing email app password in Key Vault"

    $envValues = azd env get-values 2>$null
    $kvName  = ($envValues | Select-String '^KEY_VAULT_NAME=').ToString()  -replace '^KEY_VAULT_NAME=', ''  -replace '"', ''
    $webName = ($envValues | Select-String '^SERVICE_WEB_NAME=').ToString() -replace '^SERVICE_WEB_NAME=', '' -replace '"', ''

    if ([string]::IsNullOrWhiteSpace($kvName)) {
        Write-Warn2 "Could not determine the Key Vault name; skipping password storage. You can set it later (see README)."
    }
    else {
        # The 'Key Vault Secrets Officer' role was granted during provisioning;
        # allow a little time for the RBAC assignment to propagate.
        $set = $false
        for ($i = 1; $i -le 10; $i++) {
            az keyvault secret set --vault-name $kvName --name 'EMAIL-APP-PASSWORD' --value $emailPasswordPlain --only-show-errors 1>$null 2>$null
            if ($LASTEXITCODE -eq 0) { $set = $true; break }
            Write-Host "    Waiting for Key Vault permissions to propagate... ($i/10)" -ForegroundColor DarkGray
            Start-Sleep -Seconds 15
        }

        if ($set) {
            Write-Ok "App password stored in Key Vault ($kvName)"
            if (-not [string]::IsNullOrWhiteSpace($webName)) {
                az webapp restart --name $webName --resource-group $ResourceGroup --only-show-errors 1>$null 2>$null
                Write-Ok "Web app restarted to load the secret"
            }
        }
        else {
            Write-Warn2 "Could not write the secret to Key Vault. Grant yourself 'Key Vault Secrets Officer' on '$kvName', then run:"
            Write-Warn2 "  az keyvault secret set --vault-name $kvName --name EMAIL-APP-PASSWORD --value <password>"
        }
    }

    # Best-effort: drop the plaintext password from memory.
    $emailPasswordPlain = $null
}

# ------------------------------------------------------------------
# 9. Show the result.
# ------------------------------------------------------------------
Write-Step "Deployment complete"
$values = azd env get-values 2>$null
$gwUrl  = ($values | Select-String '^APPLICATION_GATEWAY_URL=').ToString() -replace '^APPLICATION_GATEWAY_URL=', '' -replace '"', ''

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "   SUCCESS - your demo environment is live" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "   Resource group : $ResourceGroup" -ForegroundColor White
Write-Host "   Region         : $Location" -ForegroundColor White
if ($gwUrl) {
    Write-Host "   Public URL     : $gwUrl" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "   Open the Public URL in a browser to use the app." -ForegroundColor White
    Write-Host "   (Use this gateway URL - the *.azurewebsites.net URL is blocked by design.)" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "   First load may take a few seconds while the serverless SQL DB resumes." -ForegroundColor DarkGray
Write-Host ""
