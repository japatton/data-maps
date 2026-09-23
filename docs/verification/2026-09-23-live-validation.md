# Live validation — 2026-09-23

| target | endpoint | version |
|---|---|---|
| Cribl Stream | `http://<private host>:19000` | 4.19.0-0fbd6d34 |
| Elasticsearch | `http://localhost:9200` | 8.15.0 |

A green line means the target accepted the pipeline: schema and conf valid for Cribl, compiled and loaded for Elasticsearch. Neither proves correct parsing of real events.

## Cribl: 605 of 605 accepted

No failures.

## Cribl behaviour: 589 of 605 clean

One preview event per pipeline, seeded with a sentinel at every field a `rename` reads (1895 sentinels). A finding is a sentinel that vanished or a dotted key the re-nest step left flat. 20 pipelines dropped the synthetic event and prove nothing here.

### apache-httpd/access__json (`dm_apache_httpd_access_json`)

- value lost: duration_us -> 'event.duration'

### exchange/admin-audit__other (`dm_exchange_admin_audit_other`)

- value lost: Cmdlet -> 'event.action'
- value lost: ObjectModified -> 'microsoft.exchange.admin_audit.object_modified'

### exchange/mailbox-audit__api-pull (`dm_exchange_mailbox_audit_api_pull`)

- value lost: Operation -> 'event.action'
- value lost: LogonType -> 'microsoft.exchange.mailbox_audit.logon_type'
- value lost: MailboxOwnerUPN -> 'user.target.name'
- value lost: LogonUserDisplayName -> 'user.name'
- value lost: LogonUserSid -> 'microsoft.exchange.mailbox_audit.logon_user_sid'
- value lost: ClientIPAddress -> 'source.ip'
- value lost: ClientMachineName -> 'source.address'
- value lost: ClientProcessName -> 'process.name'
- value lost: ClientInfoString -> 'microsoft.exchange.mailbox_audit.client_info_string'
- value lost: ItemSubject -> 'email.subject'
- value lost: FolderPathName -> 'microsoft.exchange.mailbox_audit.folder_path'
- value lost: DestFolderPathName -> 'microsoft.exchange.mailbox_audit.dest_folder_path'
- value lost: CrossMailboxOperation -> 'microsoft.exchange.mailbox_audit.cross_mailbox'
- value lost: MailboxGuid -> 'microsoft.exchange.mailbox_audit.mailbox_guid'

### exchange/message-tracking__api-pull (`dm_exchange_message_tracking_api_pull`)

- value lost: ClientIp -> 'client.ip'
- value lost: ClientHostname -> 'client.domain'
- value lost: ServerIp -> 'server.ip'
- value lost: ServerHostname -> 'server.domain'
- value lost: SourceContext -> 'microsoft.exchange.sourcecontext'
- value lost: ConnectorId -> 'microsoft.exchange.connectorid'
- value lost: InternalMessageId -> 'microsoft.exchange.internalmessageid'
- value lost: MessageId -> 'email.message_id'
- value lost: RecipientCount -> 'microsoft.exchange.recipientcount'
- value lost: RelatedRecipientAddress -> 'microsoft.exchange.relatedrecipientaddress'
- value lost: Reference -> 'microsoft.exchange.reference'
- value lost: MessageSubject -> 'email.subject'
- value lost: Sender -> 'email.sender.address'
- value lost: ReturnPath -> 'microsoft.exchange.returnpath'
- value lost: OriginalClientIp -> 'microsoft.exchange.originalclientip'
- value lost: OriginalServerIp -> 'microsoft.exchange.originalserverip'
- value lost: TotalBytes -> 'network.bytes'
- value lost: TransportTrafficType -> 'microsoft.exchange.transporttraffictype'
- value lost: LogId -> 'microsoft.exchange.logid'
- value lost: SchemaVersion -> 'microsoft.exchange.schemaversion'
- value lost: CustomData -> 'microsoft.exchange.customdata'

### hspd12-cms/credential-lifecycle-events__api-pull (`dm_hspd12_cms_credential_lifecycle_events_api_pull`)

- value lost: cardholder_id -> 'user.target.id'
- value lost: cardholder_name -> 'user.target.name'
- value lost: cardholder_agency -> 'organization.name'
- value lost: operator_id -> 'user.name'
- value lost: operator_role -> 'user.roles'
- value lost: credential_uuid -> 'hspd12.cms.credential.uuid'
- value lost: credential_serial -> 'hspd12.cms.credential.serial'
- value lost: fascn -> 'hspd12.cms.credential.fascn'
- value lost: credential_state -> 'hspd12.cms.credential.state'
- value lost: revocation_reason -> 'event.reason'
- value lost: workstation_id -> 'host.name'
- value lost: workstation_ip -> 'source.ip'
- value lost: site_code -> 'hspd12.cms.site.code'

### pacs-badge/access-events__api-pull (`dm_pacs_badge_access_events_api_pull`)

- value lost: CardNumber -> 'pacs.badge.card_number'

### pacs-badge/door-alarm-events__api-pull (`dm_pacs_badge_door_alarm_events_api_pull`)

- value lost: CardNumber -> 'pacs.badge.card_number'

### paloalto-ngfw/globalprotect__syslog-cef (`dm_paloalto_ngfw_globalprotect_syslog_cef`)

- value lost: deviceExternalID -> 'observer.serial_number'

### paloalto-ngfw/userid__syslog-cef (`dm_paloalto_ngfw_userid_syslog_cef`)

- value lost: externalId -> 'event.sequence'

### paloalto-ngfw/userid__syslog-leef (`dm_paloalto_ngfw_userid_syslog_leef`)

- value lost: SequenceNo -> 'event.sequence'

### sharepoint-onprem/audit__api-pull (`dm_sharepoint_onprem_audit_api_pull`)

- value lost: MachineIp -> 'source.ip'
- value lost: MachineName -> 'source.address'
- value lost: EventName -> 'event.action'
- value lost: ItemType -> 'sharepoint.audit.item_type'
- value lost: LocationType -> 'sharepoint.audit.location_type'
- value lost: EventSource -> 'sharepoint.audit.event_source'
- value lost: SourceName -> 'sharepoint.audit.source_name'
- value lost: AppPrincipalId -> 'sharepoint.audit.app_principal_id'

### sharepoint-onprem/audit__jdbc-sql (`dm_sharepoint_onprem_audit_jdbc_sql`)

- value lost: MachineIp -> 'source.ip'
- value lost: MachineName -> 'source.address'
- value lost: EventName -> 'event.action'
- value lost: ItemType -> 'sharepoint.audit.item_type'
- value lost: LocationType -> 'sharepoint.audit.location_type'
- value lost: EventSource -> 'sharepoint.audit.event_source'
- value lost: SourceName -> 'sharepoint.audit.source_name'
- value lost: AppPrincipalId -> 'sharepoint.audit.app_principal_id'

### workspace-one-uem/device-events__webhook (`dm_workspace_one_uem_device_events_webhook`)

- value lost: DeviceFriendlyName -> 'host.name'
- value lost: OperatingSystem -> 'host.os.version'

### xsoar-soar/console-audit__api-pull (`dm_xsoar_soar_console_audit_api_pull`)

- value lost: user -> 'user.name'

### zos-smf/dataset-access__other (`dm_zos_smf_dataset_access_other`)

- value lost: SMF14SID -> 'host.name'
- value lost: SMF14JBN -> 'process.name'
- value lost: SMF14_JFCBDSNM -> 'file.path'

### zos-smf/dataset-access__syslog-cef (`dm_zos_smf_dataset_access_syslog_cef`)

- value lost: SMF14SID -> 'host.name'
- value lost: SMF14JBN -> 'process.name'
- value lost: SMF14_JFCBDSNM -> 'file.path'


## Elasticsearch: 605 of 605 accepted

No failures.
