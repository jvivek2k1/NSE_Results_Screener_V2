// ============================================================
// Monitoring: Log Analytics workspace + Application Insights + Action Group
// ============================================================
param location string
param tags object
param resourceToken string

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${resourceToken}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// Action group used by metric alerts. No receivers by default (alerts still fire
// and are visible in the portal); add email/SMS/webhook receivers as needed.
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${resourceToken}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'nseAlerts'
    enabled: true
  }
}

output appInsightsConnectionString string = appInsights.properties.ConnectionString
output appInsightsId string = appInsights.id
output logAnalyticsWorkspaceId string = logAnalytics.id
output actionGroupId string = actionGroup.id
