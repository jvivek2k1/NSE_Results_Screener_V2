// ============================================================
// Azure SQL: logical server (Entra-only auth) + serverless database.
// No SQL administrator login/password is ever created (Entra-only).
// ============================================================
param location string
param tags object
param resourceToken string
param databaseName string

@description('Object ID of the Entra principal set as SQL admin.')
param principalId string
@description('Display name / UPN of the Entra principal set as SQL admin.')
param principalName string
@allowed(['User', 'Group', 'Application'])
param principalType string = 'User'

@description('Resource ID of the action group that receives the SQL CPU alert.')
param actionGroupId string = ''

@description('Resource ID of the subnet (snet-pe) that hosts the SQL private endpoint.')
param peSubnetId string

@description('Resource ID of the virtual network the private DNS zone is linked to.')
param vnetId string

@allowed(['Enabled', 'Disabled'])
@description('SQL public network access. Kept \'Enabled\' during provisioning so the post-provision data-plane grant hooks (and the SRE bridge grants) can reach the server from the deploy machine. The deploy script locks it down to \'Disabled\' as a final step; all app/runtime traffic flows through the private endpoint regardless.')
param publicNetworkAccess string = 'Enabled'

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: 'sql-${resourceToken}'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    version: '12.0'
    minimalTlsVersion: '1.2'
    // Public access is parameterized: 'Enabled' during provisioning so the
    // data-plane grant hooks can connect, then the deploy script flips it to
    // 'Disabled'. Runtime traffic always uses the private endpoint (pe-sql).
    publicNetworkAccess: publicNetworkAccess
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: principalType
      login: principalName
      sid: principalId
      tenantId: subscription().tenantId
      azureADOnlyAuthentication: true
    }
  }
}

resource sqlDatabase 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: databaseName
  location: location
  tags: tags
  sku: {
    name: 'GP_S_Gen5'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: 2
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: 34359738368 // 32 GB
    autoPauseDelay: 60
    minCapacity: json('0.5')
    zoneRedundant: false
  }
}

// Firewall rule retained for parity with the live server. With
// publicNetworkAccess = 'Disabled' this rule is inert (all access flows through
// the private endpoint), but it is harmless and matches the deployed state.
resource allowAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ============================================================
// Private connectivity: private endpoint + private DNS zone so the SQL server
// resolves to a VNet-internal address (10.0.3.x) for the web app and the SQL
// bridge Function. Mirrors the live pe-sql / privatelink.database.windows.net.
// ============================================================
resource sqlPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-sql-${resourceToken}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'pe-sql-${resourceToken}'
        properties: {
          privateLinkServiceId: sqlServer.id
          groupIds: [
            'sqlServer'
          ]
        }
      }
    ]
  }
}

resource sqlPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink${environment().suffixes.sqlServerHostname}'
  location: 'global'
  tags: tags
}

resource sqlPrivateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: sqlPrivateDnsZone
  name: 'vnetlink-sql'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

// Wires the private endpoint's NIC to the private DNS zone, which creates and
// maintains the A record (sql-<token> -> 10.0.3.x) automatically.
resource sqlPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: sqlPrivateEndpoint
  name: 'sqlZoneGroup'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-database-windows-net'
        properties: {
          privateDnsZoneId: sqlPrivateDnsZone.id
        }
      }
    ]
  }
}

// Metric alert: fires when the database CPU is at or above 85% — the signal the
// SRE Agent picks up for the "SQL CPU 100%" chaos scenario. Routes to the shared
// action group so the Agent (or any receiver wired to it) is notified.
resource sqlCpuAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(actionGroupId)) {
  name: 'alert-sql-cpu-high'
  location: 'global'
  tags: tags
  properties: {
    description: 'Azure SQL database CPU at or above 85%. Used by the SRE Agent to detect and remediate CPU saturation.'
    severity: 1
    enabled: true
    scopes: [
      sqlDatabase.id
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    targetResourceType: 'Microsoft.Sql/servers/databases'
    targetResourceRegion: location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'HighCpu'
          metricNamespace: 'Microsoft.Sql/servers/databases'
          metricName: 'cpu_percent'
          operator: 'GreaterThanOrEqual'
          threshold: 85
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: actionGroupId
      }
    ]
  }
}

// Metric alert: fires when blocked sessions pile up — the signal the SRE Agent
// picks up for the "Blocking" chaos scenario. A severe blocking tree keeps 30+
// sessions parked behind head blockers, so the database's worker usage stays
// elevated. Routes to the shared action group so the Agent is notified.
resource sqlBlockingAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(actionGroupId)) {
  name: 'alert-sql-blocking-high'
  location: 'global'
  tags: tags
  properties: {
    description: 'Azure SQL database worker usage elevated by a severe blocking tree (30+ sessions blocked behind head blockers). Used by the SRE Agent to detect and remediate blocking.'
    severity: 1
    enabled: true
    scopes: [
      sqlDatabase.id
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    targetResourceType: 'Microsoft.Sql/servers/databases'
    targetResourceRegion: location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'HighWorkers'
          metricNamespace: 'Microsoft.Sql/servers/databases'
          metricName: 'workers_percent'
          operator: 'GreaterThanOrEqual'
          threshold: 10
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: actionGroupId
      }
    ]
  }
}

output sqlServerName string = sqlServer.name
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
output sqlDatabaseName string = sqlDatabase.name
output sqlPrivateEndpointName string = sqlPrivateEndpoint.name
output sqlPrivateDnsZoneName string = sqlPrivateDnsZone.name
