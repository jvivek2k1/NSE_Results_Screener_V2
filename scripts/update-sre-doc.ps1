<#
.SYNOPSIS
    Regenerate the auto-generated section of docs/SRE-AGENT-INSTRUCTIONS.md from
    the live Azure resource group.

.DESCRIPTION
    Queries the given resource group for the resources that make up the NSE
    Results Screener (App Service, App Gateway, public IP/FQDN, SQL, AI,
    Application Insights, alerts, etc.) and rewrites everything between the
    <!-- BEGIN:AUTOGEN --> and <!-- END:AUTOGEN --> markers in the SRE doc so the
    instructions always reflect the current deployment (new resource group, new
    resource token, new alerts, etc.).

    Idempotent and safe to re-run. Intended to be called automatically after a
    deployment (azd postdeploy hook and the JBDeployEnvironment script), but can
    also be run by hand:

        pwsh ./scripts/update-sre-doc.ps1 -ResourceGroup <rg> [-SubscriptionId <sub>]

    If -ResourceGroup is omitted it is read from the azd environment
    (AZURE_RESOURCE_GROUP).
#>

[CmdletBinding()]
param(
    [string] $ResourceGroup,
    [string] $SubscriptionId,
    [string] $DocPath
)

$ErrorActionPreference = 'Stop'

function Write-Info($m) { Write-Host "    [sre-doc] $m" -ForegroundColor DarkCyan }
function Write-Warn2($m) { Write-Host "    [sre-doc] $m" -ForegroundColor Yellow }

# ------------------------------------------------------------------
# Resolve repo root + doc path.
# ------------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DocPath) {
    $DocPath = Join-Path $repoRoot 'docs/SRE-AGENT-INSTRUCTIONS.md'
}
if (-not (Test-Path $DocPath)) {
    Write-Warn2 "SRE doc not found at $DocPath - skipping."
    return
}

# ------------------------------------------------------------------
# Resolve resource group + subscription (fall back to azd env).
# ------------------------------------------------------------------
if (-not $ResourceGroup -or -not $SubscriptionId) {
    try {
        Push-Location $repoRoot
        $envValues = azd env get-values 2>$null
        Pop-Location
        if ($envValues) {
            if (-not $ResourceGroup) {
                $ResourceGroup = ($envValues | Select-String '^AZURE_RESOURCE_GROUP=').ToString() `
                    -replace '^AZURE_RESOURCE_GROUP=', '' -replace '"', ''
            }
            if (-not $SubscriptionId) {
                $SubscriptionId = ($envValues | Select-String '^AZURE_SUBSCRIPTION_ID=').ToString() `
                    -replace '^AZURE_SUBSCRIPTION_ID=', '' -replace '"', ''
            }
        }
    } catch { }
}

if (-not $ResourceGroup) {
    Write-Warn2 'No resource group provided or found in azd env - skipping SRE doc update.'
    return
}

$subArg = @()
if ($SubscriptionId) { $subArg = @('--subscription', $SubscriptionId) }

Write-Info "Refreshing SRE doc from resource group '$ResourceGroup'..."

# ------------------------------------------------------------------
# Query the resource group.
# ------------------------------------------------------------------
try {
    $resources = az resource list -g $ResourceGroup @subArg -o json 2>$null | ConvertFrom-Json
} catch {
    $resources = $null
}
if (-not $resources) {
    Write-Warn2 "Could not list resources in '$ResourceGroup' (not deployed yet?) - skipping."
    return
}

function Get-ResName([string] $type) {
    ($resources | Where-Object { $_.type -ieq $type } | Select-Object -First 1 -ExpandProperty name)
}
function Get-ResNames([string] $type) {
    @($resources | Where-Object { $_.type -ieq $type } | Select-Object -ExpandProperty name)
}

$appName     = Get-ResName 'Microsoft.Web/sites'
$planName    = Get-ResName 'Microsoft.Web/serverFarms'
$agwName     = Get-ResName 'Microsoft.Network/applicationGateways'
$pipName     = Get-ResName 'Microsoft.Network/publicIPAddresses'
$wafName     = Get-ResName 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies'
$vnetName    = Get-ResName 'Microsoft.Network/virtualNetworks'
$sqlName     = Get-ResName 'Microsoft.Sql/servers'
$aiName      = Get-ResName 'Microsoft.CognitiveServices/accounts'
$appiName    = Get-ResName 'microsoft.insights/components'
$logName     = Get-ResName 'Microsoft.OperationalInsights/workspaces'
$kvName      = Get-ResName 'Microsoft.KeyVault/vaults'
$actionGroups = Get-ResNames 'microsoft.insights/actionGroups'

# Public IP address + FQDN.
$pipIp = $null; $pipFqdn = $null
if ($pipName) {
    try {
        $pip = az network public-ip show -g $ResourceGroup -n $pipName @subArg `
            --query "{ip:ipAddress, fqdn:dnsSettings.fqdn}" -o json 2>$null | ConvertFrom-Json
        if ($pip) { $pipIp = $pip.ip; $pipFqdn = $pip.fqdn }
    } catch { }
}
$publicUrl = if ($pipFqdn) { "http://$pipFqdn" } elseif ($pipIp) { "http://$pipIp" } else { '(not provisioned)' }

# Application Insights appId.
$appId = $null
if ($appiName) {
    try {
        $appId = az monitor app-insights component show -g $ResourceGroup -a $appiName @subArg `
            --query appId -o tsv 2>$null
    } catch { }
}

# SQL database name(s).
$sqlDbs = @()
if ($sqlName) {
    try {
        $sqlDbs = az sql db list -g $ResourceGroup -s $sqlName @subArg `
            --query "[?name!='master'].name" -o tsv 2>$null
    } catch { }
}
$sqlDbText = if ($sqlDbs) { ($sqlDbs -join ', ') } else { 'JBDB' }

# Alert rules (scheduled query + metric), with severity when available.
function Get-Alerts([string] $type) {
    $items = @($resources | Where-Object { $_.type -ieq $type })
    $out = @()
    foreach ($a in $items) {
        $sev = $null
        try {
            $sev = az resource show --ids $a.id @subArg --query 'properties.severity' -o tsv 2>$null
        } catch { }
        $out += [pscustomobject]@{ Name = $a.name; Severity = $sev }
    }
    $out
}
$alerts = @()
$alerts += Get-Alerts 'Microsoft.Insights/scheduledQueryRules'
$alerts += Get-Alerts 'microsoft.insights/metricAlerts'

# ------------------------------------------------------------------
# Build the auto-generated block.
# ------------------------------------------------------------------
$nl = "`n"
$ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$sb = [System.Text.StringBuilder]::new()
[void]$sb.Append("<!-- BEGIN:AUTOGEN (do not edit by hand - regenerated by scripts/update-sre-doc.ps1) -->$nl")
[void]$sb.Append("_Last refreshed: $ts (from resource group ``$ResourceGroup``)._$nl$nl")

[void]$sb.Append("| Fact | Value |$nl|---|---|$nl")
[void]$sb.Append("| Subscription | ``$SubscriptionId`` |$nl")
[void]$sb.Append("| Resource group | ``$ResourceGroup`` |$nl")
[void]$sb.Append("| Public URL (FQDN) | $publicUrl |$nl")
if ($pipIp)  { [void]$sb.Append("| Public IP | ``$pipIp`` |$nl") }
if ($appId)  { [void]$sb.Append("| App Insights appId | ``$appId`` |$nl") }
if ($aiName) { [void]$sb.Append("| AI deployment | ``NSE_RESULTS_SCREENER_MODEL`` on ``$aiName`` |$nl") }
[void]$sb.Append($nl)

[void]$sb.Append("### Resources under management$nl")
[void]$sb.Append("| Component | Name |$nl|---|---|$nl")
function Row($label, $name) {
    if ($name) { [void]$sb.Append("| $label | ``$name`` |$nl") }
}
Row 'App Service (Node 20)'          $appName
Row 'App Service plan'               $planName
Row 'Application Gateway (WAF v2)'   $agwName
Row 'Public IP / FQDN'               $(if ($pipName -and $pipFqdn) { "$pipName -> $pipFqdn" } else { $pipName })
Row 'WAF policy'                     $wafName
Row 'Virtual network'                $vnetName
Row 'Azure SQL server / db'          $(if ($sqlName) { "$sqlName / $sqlDbText" } else { $null })
Row 'Azure AI / Foundry'             $aiName
Row 'Application Insights'           $appiName
Row 'Log Analytics'                  $logName
Row 'Key Vault'                      $kvName
foreach ($ag in $actionGroups) { Row 'Action group' $ag }
[void]$sb.Append($nl)

[void]$sb.Append("### Alert rules$nl")
if ($alerts.Count -gt 0) {
    foreach ($al in ($alerts | Sort-Object Name)) {
        $sevText = if ($al.Severity -ne $null -and $al.Severity -ne '') { " (severity $($al.Severity))" } else { '' }
        [void]$sb.Append("- ``$($al.Name)``$sevText$nl")
    }
} else {
    [void]$sb.Append("- _(none found)_$nl")
}
[void]$sb.Append("<!-- END:AUTOGEN -->")

$block = $sb.ToString()

# ------------------------------------------------------------------
# Splice the block into the doc between the markers.
# ------------------------------------------------------------------
$content = Get-Content -Path $DocPath -Raw
$beginMarker = '<!-- BEGIN:AUTOGEN'
$endMarker   = '<!-- END:AUTOGEN -->'

$startIdx = $content.IndexOf($beginMarker)
$endIdx   = $content.IndexOf($endMarker)

if ($startIdx -ge 0 -and $endIdx -gt $startIdx) {
    $before = $content.Substring(0, $startIdx)
    $after  = $content.Substring($endIdx + $endMarker.Length)
    $newContent = $before + $block + $after
} else {
    Write-Warn2 'AUTOGEN markers not found in SRE doc - appending a fresh block.'
    $newContent = $content.TrimEnd() + $nl + $nl + $block + $nl
}

# Normalise to LF line endings to match the rest of the doc.
$newContent = $newContent -replace "`r`n", "`n"
Set-Content -Path $DocPath -Value $newContent -NoNewline -Encoding utf8

Write-Info "Updated $([System.IO.Path]::GetFileName($DocPath)) (RG '$ResourceGroup', app '$appName')."
