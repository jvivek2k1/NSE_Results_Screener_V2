targetScope = 'subscription'

// ============================================================
// NSE Results Screener — App Service "secure baseline"
// App Service behind an Application Gateway (WAF v2) inside a VNet,
// backed by Azure SQL, with Log Analytics + Application Insights + alerts.
// Deploys into the EXISTING resource group RG_JB_NSE_RESULTS_SCREENER.
// ============================================================

@minLength(1)
@maxLength(64)
@description('Name of the azd environment — used to derive a unique resource token.')
param environmentName string

@minLength(1)
@description('Primary location for all resources.')
param location string

@description('Location for the Azure AI Services (Foundry) account. Pinned to a\nregion with reliable model capacity; can differ from the primary location.')
param aiLocation string = 'eastus2'

@description('Existing resource group to deploy into.')
param resourceGroupName string = 'RG_JB_NSE_RESULTS_SCREENER'

@description('Object ID of the deploying user/principal (Entra SQL admin).')
param principalId string

@description('Display name / UPN of the deploying principal (Entra SQL admin).')
param principalName string

@allowed(['User', 'Group', 'Application'])
@description('Type of the deploying principal.')
param principalType string = 'User'

@description('SQL database name.')
param sqlDatabaseName string = 'JBDB'

@description('Azure OpenAI deployment (model) name created on the AI account.')
param aiDeploymentName string = 'NSE_RESULTS_SCREENER_MODEL'

@description('Azure OpenAI API version.')
param aiApiVersion string = 'preview'

@description('When "true", email-on-open notification settings are added to the app.')
param emailEnabled string = 'false'
param emailHost string = 'smtp.mail.yahoo.com'
param emailPort string = '465'
param emailUser string = ''
param emailFrom string = ''
param emailTo string = ''
param emailThrottleMinutes string = '10'

@description('Optional explicit token used in resource names (e.g. a ddMMyyHHmmss\ntimestamp set by the deploy script). Must be short (<= 12 chars recommended)\nand alphanumeric. When empty, a deterministic hash is used instead.')
@maxLength(16)
param resourceTokenOverride string = ''

@description('Local admin username for the SQL jump-box VM. Empty disables the VM.')
param vmAdminUsername string = ''

@secure()
@description('Local admin password for the SQL jump-box VM. Empty disables the VM.')
param vmAdminPassword string = ''

@description('Source IP/CIDR allowed to RDP into the jump-box. Empty = no inbound RDP rule.')
param vmAllowedSourceIp string = ''

@description('Egress IP/CIDR of the SRE Agent — the only source allowed to call the SQL-bridge Function.')
param agentEgressIp string = '172.203.122.125/32'

@description('Container image tag for the SRE SQL-bridge Function. Build/push the\nimage (az acr build -r acr<token> -t sqlbridge:<tag> ./functionapp) before or\nafter provisioning; the Function picks it up on its next restart.')
param sqlBridgeImageTag string = 'v2'

var deployVm = !empty(vmAdminUsername) && !empty(vmAdminPassword)

var resourceToken = empty(resourceTokenOverride) ? toLower(uniqueString(subscription().id, environmentName, location)) : toLower(resourceTokenOverride)
var tags = { 'azd-env-name': environmentName }

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' existing = {
  name: resourceGroupName
}

// -------------------- Monitoring --------------------
module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
  }
}

// -------------------- Networking (VNet, Public IP, WAF policy) --------------------
module network 'modules/network.bicep' = {
  name: 'network'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    mgmtAllowedSourceIp: vmAllowedSourceIp
  }
}

// -------------------- AI Services (Foundry) account + model deployment --------------------
module ai 'modules/ai.bicep' = {
  name: 'ai'
  scope: rg
  params: {
    aiLocation: aiLocation
    tags: tags
    resourceToken: resourceToken
    deploymentName: aiDeploymentName
  }
}

// -------------------- Data (SQL Server + Database, Entra-only) --------------------
module sql 'modules/sql.bicep' = {
  name: 'sql'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    databaseName: sqlDatabaseName
    principalId: principalId
    principalName: principalName
    principalType: principalType
    actionGroupId: monitoring.outputs.actionGroupId
    peSubnetId: network.outputs.peSubnetId
    vnetId: network.outputs.vnetId
  }
}

// -------------------- App Service (plan + web app, VNet integrated) --------------------
module appService 'modules/appservice.bicep' = {
  name: 'appService'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    serviceName: 'web'
    appSubnetId: network.outputs.appSubnetId
    appGatewaySubnetId: network.outputs.appGatewaySubnetId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    sqlServerFqdn: sql.outputs.sqlServerFqdn
    sqlDatabaseName: sqlDatabaseName
    aiEndpoint: ai.outputs.aiEndpoint
    aiDeploymentName: aiDeploymentName
    aiApiVersion: aiApiVersion
    keyVaultName: 'kv-${resourceToken}'
    subscriptionId: subscription().subscriptionId
    resourceGroupName: rg.name
    sqlServerName: sql.outputs.sqlServerName
    aiAccountName: ai.outputs.aiAccountName
    emailEnabled: emailEnabled
    emailHost: emailHost
    emailPort: emailPort
    emailUser: emailUser
    emailFrom: emailFrom
    emailTo: emailTo
    emailThrottleMinutes: emailThrottleMinutes
  }
}

// -------------------- Key Vault (app secrets, e.g. email app password) --------------------
module keyVault 'modules/keyvault.bicep' = {
  name: 'keyVault'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    appPrincipalId: appService.outputs.appPrincipalId
    deployerPrincipalId: principalId
    deployerPrincipalType: principalType
  }
}

// -------------------- SQL jump-box VM (SSMS, on the SQL VNet) --------------------
// Created only when admin credentials are supplied. The deploy script prompts
// for them and passes via vmAdminUsername/vmAdminPassword.
module jumpbox 'modules/jumpbox.bicep' = if (deployVm) {
  name: 'jumpbox'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    mgmtSubnetId: network.outputs.mgmtSubnetId
    adminUsername: vmAdminUsername
    adminPassword: vmAdminPassword
  }
}

// -------------------- Grant App MI access to the AI resource --------------------
module aiAccess 'modules/ai-access.bicep' = {
  name: 'aiAccess'
  scope: rg
  params: {
    aiAccountName: ai.outputs.aiAccountName
    principalId: appService.outputs.appPrincipalId
  }
}

// -------------------- Grant App MI management roles for the SRE chaos demo --------------------
module chaosAccess 'modules/chaos-access.bicep' = {
  name: 'chaosAccess'
  scope: rg
  params: {
    sqlServerName: sql.outputs.sqlServerName
    aiAccountName: ai.outputs.aiAccountName
    principalId: appService.outputs.appPrincipalId
  }
}

// -------------------- Application Gateway (WAF v2) + alert --------------------
module appGateway 'modules/appgateway.bicep' = {
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    appGatewaySubnetId: network.outputs.appGatewaySubnetId
    publicIpId: network.outputs.publicIpId
    wafPolicyId: network.outputs.wafPolicyId
    backendFqdn: appService.outputs.appHostName
    actionGroupId: monitoring.outputs.actionGroupId
  }
}

// -------------------- SRE SQL bridge (VNet-integrated container Function) --------------------
module sqlBridge 'modules/sqlbridge.bicep' = {
  name: 'sqlBridge'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    funcSubnetId: network.outputs.funcSubnetId
    sqlServerFqdn: sql.outputs.sqlServerFqdn
    sqlDatabaseName: sqlDatabaseName
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    agentEgressIp: agentEgressIp
    imageTag: sqlBridgeImageTag
  }
}

// -------------------- Outputs (consumed by azd + postprovision script) --------------------
output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_TENANT_ID string = subscription().tenantId

output SQL_SERVER string = sql.outputs.sqlServerName
output SQL_DATABASE string = sqlDatabaseName
output SQL_GRANT_DDLADMIN string = 'true'

output AZURE_SQL_SERVER string = sql.outputs.sqlServerFqdn
output AZURE_SQL_DATABASE string = sqlDatabaseName
output AZURE_OPENAI_ENDPOINT string = ai.outputs.aiEndpoint
output AZURE_OPENAI_DEPLOYMENT string = aiDeploymentName

output SERVICE_WEB_NAME string = appService.outputs.appName
output SERVICE_WEB_URI string = 'https://${appService.outputs.appHostName}'
output APPLICATION_GATEWAY_URL string = 'http://${appGateway.outputs.publicIpAddress}'
output KEY_VAULT_NAME string = keyVault.outputs.keyVaultName
output SQL_JUMPBOX_FQDN string = deployVm ? jumpbox.outputs.vmFqdn : ''
output SQL_JUMPBOX_PRIVATE_IP string = deployVm ? jumpbox.outputs.vmPrivateIp : ''

output SQL_BRIDGE_FUNCTION_NAME string = sqlBridge.outputs.functionAppName
output SQL_BRIDGE_FUNCTION_URL string = 'https://${sqlBridge.outputs.functionAppHostName}'
output SQL_BRIDGE_ACR_NAME string = sqlBridge.outputs.acrName
output SQL_BRIDGE_ACR_LOGIN_SERVER string = sqlBridge.outputs.acrLoginServer
