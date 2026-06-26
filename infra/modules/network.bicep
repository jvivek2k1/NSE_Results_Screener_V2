// ============================================================
// Networking: Virtual Network (App Gateway + App Service subnets),
// Public IP for the gateway, and the WAF policy.
// ============================================================
param location string
param tags object
param resourceToken string

var appGatewaySubnetName = 'snet-appgw'
var appSubnetName = 'snet-app'

// NSG for the Application Gateway subnet. App Gateway v2 requires inbound from the
// Internet (80/443) for client traffic and from the GatewayManager service tag
// (65200-65535) for control-plane health. The default rules already allow the
// Azure Load Balancer and intra-VNet traffic. Without the Internet rule, the
// subnet's default DenyAllInBound blocks all public access (TCP timeouts).
// Named to match the portal-generated NSG so `azd provision` adopts it.
resource appGatewayNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'vnet-${resourceToken}-snet-appgw-nsg-${location}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowInternetHttpInbound'
        properties: {
          priority: 1000
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRanges: [
            '80'
            '443'
          ]
        }
      }
      {
        name: 'AllowGatewayManagerInbound'
        properties: {
          priority: 1010
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'GatewayManager'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '65200-65535'
        }
      }
    ]
  }
}

// NSG for the App Service integration subnet. The subnet is outbound-only
// (regional VNet integration, delegated to Microsoft.Web/serverFarms); the
// default rules already permit the required outbound traffic. Declared so the
// subnet has an explicit, version-controlled NSG (matches the deployed set).
resource appNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: 'vnet-${resourceToken}-snet-app-nsg-${location}'
  location: location
  tags: tags
  properties: {
    securityRules: []
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: 'vnet-${resourceToken}'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/16'
      ]
    }
    subnets: [
      {
        name: appGatewaySubnetName
        properties: {
          addressPrefix: '10.0.1.0/24'
          networkSecurityGroup: {
            id: appGatewayNsg.id
          }
          // Service endpoint so the App Service can restrict inbound traffic
          // to this subnet (the Application Gateway).
          serviceEndpoints: [
            {
              service: 'Microsoft.Web'
            }
          ]
        }
      }
      {
        name: appSubnetName
        properties: {
          addressPrefix: '10.0.2.0/24'
          networkSecurityGroup: {
            id: appNsg.id
          }
          // Delegated to App Service for regional VNet integration (outbound).
          delegations: [
            {
              name: 'webapp'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
        }
      }
    ]
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: 'pip-${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: 'nse-${resourceToken}'
    }
  }
}

resource wafPolicy 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies@2023-11-01' = {
  name: 'waf-${resourceToken}'
  location: location
  tags: tags
  properties: {
    policySettings: {
      state: 'Enabled'
      mode: 'Prevention'
      requestBodyCheck: true
      maxRequestBodySizeInKb: 128
      fileUploadLimitInMb: 100
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'OWASP'
          ruleSetVersion: '3.2'
        }
      ]
    }
  }
}

output appGatewaySubnetId string = '${vnet.id}/subnets/${appGatewaySubnetName}'
output appSubnetId string = '${vnet.id}/subnets/${appSubnetName}'
output publicIpId string = publicIp.id
output wafPolicyId string = wafPolicy.id
