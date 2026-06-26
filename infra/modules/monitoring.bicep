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

// Log-search alert: detects database connectivity loss directly from telemetry,
// without waiting on the App Gateway probe's 90s unhealthy threshold. Fires in
// ~1-2 min and carries the exact SQL/connection error text into the alert as a
// dimension (Detail), so the SRE Agent can root-cause immediately.
//
// Matches: ConnectionError exceptions, known SQL failure messages, failed SQL
// dependencies, and 503s from the DB-aware readiness probe (/api/health/ready).
resource dbConnectivityAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-db-connectivity-loss'
  location: location
  tags: tags
  properties: {
    displayName: 'alert-db-connectivity-loss'
    description: 'Database connectivity errors detected in application telemetry (faster signal than the App Gateway backend-health alert).'
    severity: 1
    enabled: true
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
union
  (exceptions
    | where type has 'ConnectionError'
        or outerMessage has_any ('Deny Public Network Access', 'is not allowed', 'Login failed', 'AADSTS', 'ETIMEOUT', 'paused', 'resuming')
    | extend Detail = outerMessage),
  (dependencies
    | where type == 'SQL' and success == false
    | extend Detail = strcat(name, ' | ', resultCode)),
  (requests
    | where url endswith '/api/health/ready' and toint(resultCode) == 503
    | extend Detail = '/api/health/ready 503')
| summarize Count = count() by Detail = tostring(Detail)
'''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          dimensions: [
            {
              name: 'Detail'
              operator: 'Include'
              values: [
                '*'
              ]
            }
          ]
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

output appInsightsConnectionString string = appInsights.properties.ConnectionString
output appInsightsId string = appInsights.id
output logAnalyticsWorkspaceId string = logAnalytics.id
output actionGroupId string = actionGroup.id
