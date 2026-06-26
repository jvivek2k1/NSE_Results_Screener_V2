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

@description('Existing Azure OpenAI / Foundry account name (same resource group).')
param aiAccountName string = 'nse-results-screener-resource'

@description('Azure OpenAI endpoint used by the app.')
param aiEndpoint string = 'https://nse-results-screener-resource.services.ai.azure.com'

@description('Azure OpenAI deployment (model) name.')
param aiDeploymentName string = 'NSE_RESULTS_SCREENER_MODEL'

@description('Azure OpenAI API version.')
param aiApiVersion string = 'preview'

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
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
    aiEndpoint: aiEndpoint
    aiDeploymentName: aiDeploymentName
    aiApiVersion: aiApiVersion
  }
}

// -------------------- Grant App MI access to the existing AI resource --------------------
module aiAccess 'modules/ai-access.bicep' = {
  name: 'aiAccess'
  scope: rg
  params: {
    aiAccountName: aiAccountName
    principalId: appService.outputs.appPrincipalId
  }
}

// -------------------- Application Gateway (WAF v2) + alert --------------------
module appGateway 'modules/appgateway.bicep' = {
  name: 'appGateway'
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

// -------------------- Outputs (consumed by azd + postprovision script) --------------------
output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_TENANT_ID string = subscription().tenantId

output SQL_SERVER string = sql.outputs.sqlServerName
output SQL_DATABASE string = sqlDatabaseName
output SQL_GRANT_DDLADMIN string = 'true'

output AZURE_SQL_SERVER string = sql.outputs.sqlServerFqdn
output AZURE_SQL_DATABASE string = sqlDatabaseName
output AZURE_OPENAI_ENDPOINT string = aiEndpoint
output AZURE_OPENAI_DEPLOYMENT string = aiDeploymentName

output SERVICE_WEB_NAME string = appService.outputs.appName
output SERVICE_WEB_URI string = 'https://${appService.outputs.appHostName}'
output APPLICATION_GATEWAY_URL string = 'http://${appGateway.outputs.publicIpAddress}'
