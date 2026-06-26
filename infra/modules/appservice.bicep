// ============================================================
// App Service: Linux plan + web app (Node 20), system-assigned identity,
// regional VNet integration, and inbound access restricted to the
// Application Gateway subnet (secure baseline).
// ============================================================
param location string
param tags object
param resourceToken string
param serviceName string = 'web'

param appSubnetId string
param appGatewaySubnetId string
param appInsightsConnectionString string
param sqlServerFqdn string
param sqlDatabaseName string
param aiEndpoint string
param aiDeploymentName string
param aiApiVersion string

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-${resourceToken}'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: 'P1v3'
    tier: 'PremiumV3'
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'app-${resourceToken}'
  location: location
  kind: 'app,linux'
  tags: union(tags, { 'azd-service-name': serviceName })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    virtualNetworkSubnetId: appSubnetId
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      vnetRouteAllEnabled: false
      healthCheckPath: '/api/health'
      appCommandLine: 'node server.js'
      // Restrict inbound traffic to the Application Gateway subnet only.
      ipSecurityRestrictions: [
        {
          vnetSubnetResourceId: appGatewaySubnetId
          action: 'Allow'
          priority: 100
          name: 'Allow-AppGateway-Subnet'
        }
      ]
      ipSecurityRestrictionsDefaultAction: 'Deny'
      scmIpSecurityRestrictionsUseMain: false
      appSettings: [
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'ENABLE_ORYX_BUILD', value: 'true' }
        { name: 'WEBSITES_CONTAINER_START_TIME_LIMIT', value: '600' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
        { name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' }
        { name: 'XDT_MicrosoftApplicationInsights_Mode', value: 'recommended' }
        { name: 'DB_BACKEND', value: 'azure-sql' }
        { name: 'DATA_MODE', value: 'live' }
        { name: 'AZURE_SQL_SERVER', value: sqlServerFqdn }
        { name: 'AZURE_SQL_DATABASE', value: sqlDatabaseName }
        { name: 'AZURE_OPENAI_ENDPOINT', value: aiEndpoint }
        { name: 'AZURE_OPENAI_DEPLOYMENT', value: aiDeploymentName }
        { name: 'AZURE_OPENAI_API_VERSION', value: aiApiVersion }
        { name: 'AI_READ_PDF', value: 'true' }
        { name: 'FILING_MAX_REPORTING_LAG_DAYS', value: '90' }
      ]
    }
  }
}

output appName string = webApp.name
output appHostName string = webApp.properties.defaultHostName
output appPrincipalId string = webApp.identity.principalId
output appResourceId string = webApp.id
