// ============================================================
// SQL jump-box VM — Windows Server in the management subnet (snet-mgmt) on the
// same VNet as Azure SQL, so it can reach the database through the private
// endpoint. A custom-script extension installs SQL Server 2025 Developer edition
// (falls back to 2022 if the 2025 media is unavailable) plus SSMS, giving you a
// ready-to-use admin box inside the network.
// ============================================================
param location string
param tags object
param resourceToken string

@description('Resource ID of the management subnet the VM joins.')
param mgmtSubnetId string

@description('VM size.')
param vmSize string = 'Standard_D2s_v5'

@description('Local admin username.')
param adminUsername string

@secure()
@description('Local admin password.')
param adminPassword string

var vmName = 'vm-sqljump-${resourceToken}'

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: 'pip-vm-${resourceToken}'
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
      domainNameLabel: 'sqljump-${resourceToken}'
    }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: 'nic-vm-${resourceToken}'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: {
            id: mgmtSubnetId
          }
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: vmName
  location: location
  tags: tags
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: 'sqljump'
      adminUsername: adminUsername
      adminPassword: adminPassword
    }
    storageProfile: {
      imageReference: {
        publisher: 'MicrosoftWindowsServer'
        offer: 'WindowsServer'
        sku: '2022-datacenter-azure-edition'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
  }
}

// Install SQL Server 2025 Developer edition (fallback to 2022) + SSMS, silently.
resource installSql 'Microsoft.Compute/virtualMachines/extensions@2023-09-01' = {
  parent: vm
  name: 'InstallSqlDevAndSsms'
  location: location
  properties: {
    publisher: 'Microsoft.Compute'
    type: 'CustomScriptExtension'
    typeHandlerVersion: '1.10'
    autoUpgradeMinorVersion: true
    settings: {
      commandToExecute: 'powershell -ExecutionPolicy Unrestricted -Command "$ErrorActionPreference=\'Continue\'; $d=\'C:\\sqlsetup\'; New-Item -ItemType Directory -Force -Path $d | Out-Null; try { Invoke-WebRequest -UseBasicParsing -Uri \'https://aka.ms/sql2025-developer-iso\' -OutFile $d\\sql.iso } catch { Invoke-WebRequest -UseBasicParsing -Uri \'https://go.microsoft.com/fwlink/?linkid=2215158\' -OutFile $d\\sql.iso }; $m=Mount-DiskImage -ImagePath $d\\sql.iso -PassThru; $v=($m | Get-Volume).DriveLetter; & ($v+\':\\setup.exe\') /Q /ACTION=Install /FEATURES=SQLENGINE /INSTANCENAME=MSSQLSERVER /SQLSYSADMINACCOUNTS=BUILTIN\\Administrators /IACCEPTSQLSERVERLICENSETERMS /EDITION=Developer /TCPENABLED=1; Dismount-DiskImage -ImagePath $d\\sql.iso; Invoke-WebRequest -UseBasicParsing -Uri \'https://aka.ms/ssmsfullsetup\' -OutFile $d\\ssms.exe; Start-Process $d\\ssms.exe -ArgumentList \'/install /quiet /norestart\' -Wait"'
    }
  }
}

output vmName string = vm.name
output vmFqdn string = publicIp.properties.dnsSettings.fqdn
output vmPrivateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
