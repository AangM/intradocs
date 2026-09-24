/**
 * Writes the synthetic Technology Architecture model as Sparx EA would export it:
 *   fixtures/ta/sparx-technology-demo.xmi   (Publish > Export XMI 2.1, EA extension)
 *   fixtures/ta/technology-template.csv     (the CSV template, same model)
 * Every name, address and date is invented. Run with `pnpm ta:fixture`; the files are
 * committed so tests and the demo do not depend on running this.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Deterministic Sparx-style GUID from a name, so re-running produces the same file. */
const guid = (name: string) => {
  const h = createHash('sha256')
    .update('intradocs-ta:' + name)
    .digest('hex')
    .toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

type El = {
  name: string;
  type: string; // UML metaclass as Sparx writes it
  stereotype: string; // ArchiMate or custom stereotype
  status?: string;
  notes?: string;
  tags?: Record<string, string>;
};
const DC1 = 'DC Jakarta (Cibitung)';
const DC2 = 'DRC Surabaya';
const elements: El[] = [
  {
    name: DC1,
    type: 'uml:Node',
    stereotype: 'ArchiMate_Location',
    notes: 'Data center utama, tier III.',
  },
  {
    name: DC2,
    type: 'uml:Node',
    stereotype: 'ArchiMate_Location',
    notes: 'Disaster recovery center.',
  },
  {
    name: 'Segmen DMZ',
    type: 'uml:Node',
    stereotype: 'ArchiMate_CommunicationNetwork',
    tags: { vlan: '110', subnet: '10.10.10.0/24', location: DC1 },
  },
  {
    name: 'Segmen Aplikasi',
    type: 'uml:Node',
    stereotype: 'ArchiMate_CommunicationNetwork',
    tags: { vlan: '120', subnet: '10.10.20.0/24', location: DC1 },
  },
  {
    name: 'Segmen Database',
    type: 'uml:Node',
    stereotype: 'ArchiMate_CommunicationNetwork',
    tags: { vlan: '130', subnet: '10.10.30.0/24', location: DC1 },
  },
  {
    name: 'Segmen Manajemen',
    type: 'uml:Node',
    stereotype: 'ArchiMate_CommunicationNetwork',
    tags: { vlan: '199', subnet: '10.10.99.0/24', location: DC1 },
  },
  {
    name: 'fw-jkt-01',
    type: 'uml:Device',
    stereotype: 'firewall',
    tags: {
      hostname: 'fw-jkt-01',
      ip_address: '10.10.99.1',
      environment: 'production',
      location: DC1,
      os: 'FortiOS',
      os_version: '7.2',
      owner: 'Tim Network',
      end_of_support: '2027-09-30',
      vendor: 'Fortinet (sintetis)',
    },
  },
  {
    name: 'core-sw-jkt-01',
    type: 'uml:Device',
    stereotype: 'switch',
    tags: {
      hostname: 'core-sw-jkt-01',
      ip_address: '10.10.99.2',
      environment: 'production',
      location: DC1,
      os: 'NX-OS',
      os_version: '9.3',
      owner: 'Tim Network',
      end_of_support: '2028-12-31',
    },
  },
  {
    name: 'lb-jkt-01',
    type: 'uml:Device',
    stereotype: 'load balancer',
    tags: {
      hostname: 'lb-jkt-01',
      ip_address: '10.10.10.5',
      environment: 'production',
      location: DC1,
      os: 'TMOS',
      os_version: '15.1',
      owner: 'Tim Network',
      end_of_support: '2026-12-31',
    },
  },
  {
    name: 'esx-jkt-01',
    type: 'uml:Node',
    stereotype: 'server',
    tags: {
      hostname: 'esx-jkt-01',
      ip_address: '10.10.99.11',
      environment: 'production',
      location: DC1,
      os: 'VMware ESXi',
      os_version: '7.0 U3',
      owner: 'Tim Infrastruktur',
      end_of_support: '2025-10-02',
      cpu: '2x 20 core',
      ram: '512 GB',
    },
  },
  {
    name: 'esx-jkt-02',
    type: 'uml:Node',
    stereotype: 'server',
    tags: {
      hostname: 'esx-jkt-02',
      ip_address: '10.10.99.12',
      environment: 'production',
      location: DC1,
      os: 'VMware ESXi',
      os_version: '8.0 U2',
      owner: 'Tim Infrastruktur',
      end_of_support: '2027-10-11',
      cpu: '2x 24 core',
      ram: '768 GB',
    },
  },
  {
    name: 'esx-sby-01',
    type: 'uml:Node',
    stereotype: 'server',
    tags: {
      hostname: 'esx-sby-01',
      ip_address: '10.20.99.11',
      environment: 'dr',
      location: DC2,
      os: 'VMware ESXi',
      os_version: '8.0 U2',
      owner: 'Tim Infrastruktur',
      end_of_support: '2027-10-11',
    },
  },
  {
    name: 'san-jkt-01',
    type: 'uml:Node',
    stereotype: 'storage',
    tags: {
      hostname: 'san-jkt-01',
      ip_address: '10.10.99.21',
      environment: 'production',
      location: DC1,
      owner: 'Tim Infrastruktur',
      capacity: '120 TB',
      end_of_support: '2029-03-31',
    },
  },
  {
    name: 'srv-web-01',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    tags: {
      hostname: 'srv-web-01',
      ip_address: '10.10.10.21',
      environment: 'production',
      location: DC1,
      os: 'Ubuntu Server',
      os_version: '22.04 LTS',
      owner: 'Tim Aplikasi',
      end_of_support: '2027-04-30',
    },
  },
  {
    name: 'srv-web-02',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    tags: {
      hostname: 'srv-web-02',
      ip_address: '10.10.10.22',
      environment: 'production',
      location: DC1,
      os: 'Ubuntu Server',
      os_version: '22.04 LTS',
      owner: 'Tim Aplikasi',
      end_of_support: '2027-04-30',
    },
  },
  {
    name: 'srv-app-01',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    tags: {
      hostname: 'srv-app-01',
      ip_address: '10.10.20.31',
      environment: 'production',
      location: DC1,
      os: 'Windows Server',
      os_version: '2016',
      owner: 'Tim Aplikasi',
      end_of_support: '2027-01-12',
    },
  },
  {
    name: 'srv-app-02',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    tags: {
      hostname: 'srv-app-02',
      ip_address: '10.10.20.32',
      environment: 'production',
      location: DC1,
      os: 'Red Hat Enterprise Linux',
      os_version: '8.10',
      owner: 'Tim Aplikasi',
      end_of_support: '2029-05-31',
    },
  },
  {
    name: 'srv-db-01',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    tags: {
      hostname: 'srv-db-01',
      ip_address: '10.10.30.41',
      environment: 'production',
      location: DC1,
      os: 'Red Hat Enterprise Linux',
      os_version: '8.10',
      owner: 'Tim Database',
      end_of_support: '2029-05-31',
    },
  },
  {
    name: 'srv-db-dr-01',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    tags: {
      hostname: 'srv-db-dr-01',
      ip_address: '10.20.30.41',
      environment: 'dr',
      location: DC2,
      os: 'Red Hat Enterprise Linux',
      os_version: '8.10',
      owner: 'Tim Database',
      end_of_support: '2029-05-31',
    },
  },
  {
    name: 'srv-ad-01',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    tags: {
      hostname: 'srv-ad-01',
      ip_address: '10.10.99.51',
      environment: 'production',
      location: DC1,
      os: 'Windows Server',
      os_version: '2019',
      owner: 'Tim Infrastruktur',
      end_of_support: '2029-01-09',
    },
  },
  {
    name: 'srv-mon-01',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    tags: {
      hostname: 'srv-mon-01',
      ip_address: '10.10.99.61',
      environment: 'production',
      location: DC1,
      os: 'CentOS',
      os_version: '7.9',
      owner: 'Tim Infrastruktur',
      end_of_support: '2024-06-30',
    },
    notes: 'Menunggu migrasi ke Rocky Linux 9.',
  },
  {
    name: 'srv-app-stg-01',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    tags: {
      hostname: 'srv-app-stg-01',
      ip_address: '10.10.20.131',
      environment: 'staging',
      location: DC1,
      os: 'Red Hat Enterprise Linux',
      os_version: '8.10',
      owner: 'Tim Aplikasi',
      end_of_support: '2029-05-31',
    },
  },
  {
    name: 'srv-legacy-01',
    type: 'uml:Node',
    stereotype: 'virtual machine',
    status: 'Retiring',
    tags: {
      hostname: 'srv-legacy-01',
      ip_address: '10.10.20.99',
      environment: 'production',
      location: DC1,
      os: 'Windows Server',
      os_version: '2012 R2',
      owner: 'Tim Aplikasi',
      end_of_support: '2023-10-10',
    },
    notes: 'Dijadwalkan pensiun setelah migrasi Aplikasi Absensi versi lama.',
  },
  {
    name: 'PostgreSQL 13',
    type: 'uml:ExecutionEnvironment',
    stereotype: 'ArchiMate_SystemSoftware',
    tags: {
      os: 'PostgreSQL',
      os_version: '13.14',
      environment: 'production',
      owner: 'Tim Database',
      end_of_support: '2025-11-13',
    },
  },
  {
    name: 'PostgreSQL 16',
    type: 'uml:ExecutionEnvironment',
    stereotype: 'ArchiMate_SystemSoftware',
    tags: {
      os: 'PostgreSQL',
      os_version: '16.3',
      environment: 'production',
      owner: 'Tim Database',
      end_of_support: '2028-11-09',
    },
  },
  {
    name: 'Nginx',
    type: 'uml:ExecutionEnvironment',
    stereotype: 'ArchiMate_SystemSoftware',
    tags: { os: 'Nginx', os_version: '1.24', environment: 'production', owner: 'Tim Aplikasi' },
  },
  {
    name: 'Active Directory',
    type: 'uml:ExecutionEnvironment',
    stereotype: 'ArchiMate_SystemSoftware',
    tags: { environment: 'production', owner: 'Tim Infrastruktur' },
  },
  {
    name: 'Portal Tiket',
    type: 'uml:Component',
    stereotype: 'ArchiMate_ApplicationComponent',
    tags: { environment: 'production', owner: 'Tim Aplikasi', criticality: 'Tinggi' },
    notes: 'Portal permintaan layanan TI.',
  },
  {
    name: 'Aplikasi Absensi',
    type: 'uml:Component',
    stereotype: 'ArchiMate_ApplicationComponent',
    tags: { environment: 'production', owner: 'Tim Aplikasi', criticality: 'Tinggi' },
  },
  {
    name: 'IntraDocs',
    type: 'uml:Component',
    stereotype: 'ArchiMate_ApplicationComponent',
    tags: { environment: 'production', owner: 'Tim Aplikasi', criticality: 'Sedang' },
  },
  {
    name: 'Zabbix Monitoring',
    type: 'uml:Component',
    stereotype: 'ArchiMate_ApplicationComponent',
    tags: { environment: 'production', owner: 'Tim Infrastruktur', criticality: 'Sedang' },
  },
  // Not Technology Architecture: must be skipped by the importer, and said so.
  { name: 'Divisi Keuangan', type: 'uml:Actor', stereotype: 'ArchiMate_BusinessActor' },
];
type Rel = [string, string, string, string]; // [source, target, ea_type, stereotype]
const relations: Rel[] = [
  // physical placement
  ['esx-jkt-01', DC1, 'Association', 'located in'],
  ['esx-jkt-02', DC1, 'Association', 'located in'],
  ['san-jkt-01', DC1, 'Association', 'located in'],
  ['fw-jkt-01', DC1, 'Association', 'located in'],
  ['core-sw-jkt-01', DC1, 'Association', 'located in'],
  ['lb-jkt-01', DC1, 'Association', 'located in'],
  ['esx-sby-01', DC2, 'Association', 'located in'],
  // network
  ['core-sw-jkt-01', 'fw-jkt-01', 'Association', 'connects'],
  ['Segmen DMZ', 'core-sw-jkt-01', 'Association', 'connects'],
  ['Segmen Aplikasi', 'core-sw-jkt-01', 'Association', 'connects'],
  ['Segmen Database', 'core-sw-jkt-01', 'Association', 'connects'],
  ['Segmen Manajemen', 'core-sw-jkt-01', 'Association', 'connects'],
  ['lb-jkt-01', 'Segmen DMZ', 'Association', 'connects'],
  ['srv-web-01', 'Segmen DMZ', 'Association', 'connects'],
  ['srv-web-02', 'Segmen DMZ', 'Association', 'connects'],
  ['srv-app-01', 'Segmen Aplikasi', 'Association', 'connects'],
  ['srv-app-02', 'Segmen Aplikasi', 'Association', 'connects'],
  ['srv-legacy-01', 'Segmen Aplikasi', 'Association', 'connects'],
  ['srv-db-01', 'Segmen Database', 'Association', 'connects'],
  ['srv-ad-01', 'Segmen Manajemen', 'Association', 'connects'],
  ['srv-mon-01', 'Segmen Manajemen', 'Association', 'connects'],
  // hypervisors host VMs (ArchiMate assignment)
  ['esx-jkt-01', 'srv-web-01', 'Association', 'ArchiMate_Assignment'],
  ['esx-jkt-01', 'srv-app-01', 'Association', 'ArchiMate_Assignment'],
  ['esx-jkt-01', 'srv-mon-01', 'Association', 'ArchiMate_Assignment'],
  ['esx-jkt-01', 'srv-legacy-01', 'Association', 'ArchiMate_Assignment'],
  ['esx-jkt-02', 'srv-web-02', 'Association', 'ArchiMate_Assignment'],
  ['esx-jkt-02', 'srv-app-02', 'Association', 'ArchiMate_Assignment'],
  ['esx-jkt-02', 'srv-db-01', 'Association', 'ArchiMate_Assignment'],
  ['esx-jkt-02', 'srv-ad-01', 'Association', 'ArchiMate_Assignment'],
  ['esx-jkt-02', 'srv-app-stg-01', 'Association', 'ArchiMate_Assignment'],
  ['esx-sby-01', 'srv-db-dr-01', 'Association', 'ArchiMate_Assignment'],
  // storage
  ['esx-jkt-01', 'san-jkt-01', 'Dependency', 'stores'],
  ['esx-jkt-02', 'san-jkt-01', 'Dependency', 'stores'],
  // platforms deployed on VMs
  ['Nginx', 'srv-web-01', 'Deployment', ''],
  ['Nginx', 'srv-web-02', 'Deployment', ''],
  ['PostgreSQL 16', 'srv-db-01', 'Deployment', ''],
  ['PostgreSQL 13', 'srv-legacy-01', 'Deployment', ''],
  ['Active Directory', 'srv-ad-01', 'Deployment', ''],
  // applications
  ['Portal Tiket', 'srv-app-02', 'Deployment', ''],
  ['Portal Tiket', 'Nginx', 'Dependency', 'uses'],
  ['Portal Tiket', 'PostgreSQL 16', 'Dependency', 'uses'],
  ['Portal Tiket', 'Active Directory', 'Dependency', 'uses'],
  ['Aplikasi Absensi', 'srv-app-01', 'Deployment', ''],
  ['Aplikasi Absensi', 'PostgreSQL 16', 'Dependency', 'uses'],
  ['Aplikasi Absensi', 'Active Directory', 'Dependency', 'uses'],
  ['Aplikasi Absensi', 'lb-jkt-01', 'Dependency', 'uses'],
  ['IntraDocs', 'srv-app-02', 'Deployment', ''],
  ['IntraDocs', 'PostgreSQL 16', 'Dependency', 'uses'],
  ['Zabbix Monitoring', 'srv-mon-01', 'Deployment', ''],
  ['Zabbix Monitoring', 'PostgreSQL 13', 'Dependency', 'uses'],
  // a serving relation written the ArchiMate way (target depends on source)
  ['lb-jkt-01', 'Portal Tiket', 'Association', 'ArchiMate_Serving'],
  // business layer, outside Technology Architecture: ignored by the importer
  ['Divisi Keuangan', 'Aplikasi Absensi', 'Association', 'ArchiMate_Serving'],
];

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const eaid = (name: string) => 'EAID_' + guid(name).replace(/-/g, '_');

function xmi(): string {
  const pkg = 'EAPK_' + guid('package').replace(/-/g, '_');
  const packaged = elements
    .map(
      (e) =>
        `\t\t\t\t<packagedElement xmi:type="${e.type}" xmi:id="${eaid(e.name)}" name="${esc(e.name)}" visibility="public"/>`,
    )
    .join('\n');
  const ext = elements
    .map((e) => {
      const tags = Object.entries(e.tags ?? {})
        .map(
          ([k, v]) =>
            `\t\t\t\t\t<tag xmi:id="EAID_TG${guid(e.name + k).slice(0, 8)}" name="${esc(k)}" value="${esc(v)}" modelElement="${eaid(e.name)}"/>`,
        )
        .join('\n');
      return [
        `\t\t\t<element xmi:idref="${eaid(e.name)}" xmi:type="${e.type}" name="${esc(e.name)}" scope="public">`,
        `\t\t\t\t<model package="${pkg}" ea_eleType="element"/>`,
        `\t\t\t\t<properties documentation="${esc(e.notes ?? '')}" isSpecification="false" sType="${e.type.replace('uml:', '')}" nType="0" scope="public" stereotype="${esc(e.stereotype)}" status="${esc(e.status ?? 'Approved')}"/>`,
        `\t\t\t\t<project author="Arsitek Sintetis" version="1.0" phase="1.0" created="2026-09-15 09:00:00" modified="2026-09-22 16:30:00" complexity="1" status="${esc(e.status ?? 'Approved')}"/>`,
        tags ? `\t\t\t\t<tags>\n${tags}\n\t\t\t\t</tags>` : '\t\t\t\t<tags/>',
        `\t\t\t\t<xrefs/>`,
        `\t\t\t</element>`,
      ].join('\n');
    })
    .join('\n');
  const conns = relations
    .map(([s, t, type, st], i) => {
      const id = 'EAID_' + guid(`rel:${i}:${s}->${t}`).replace(/-/g, '_');
      return [
        `\t\t\t<connector xmi:idref="${id}">`,
        `\t\t\t\t<source xmi:idref="${eaid(s)}"><model type="${elements.find((e) => e.name === s)?.type.replace('uml:', '')}" name="${esc(s)}"/></source>`,
        `\t\t\t\t<target xmi:idref="${eaid(t)}"><model type="${elements.find((e) => e.name === t)?.type.replace('uml:', '')}" name="${esc(t)}"/></target>`,
        `\t\t\t\t<properties ea_type="${type}"${st ? ` stereotype="${esc(st)}"` : ''} direction="Source -&gt; Destination"/>`,
        `\t\t\t</connector>`,
      ].join('\n');
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- DATA SINTETIS untuk pengujian IntraDocs. Bukan model organisasi mana pun. -->
<xmi:XMI xmi:version="2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1">
\t<xmi:Documentation exporter="Enterprise Architect" exporterVersion="6.5" exporterID="1628"/>
\t<uml:Model xmi:type="uml:Model" name="EA_Model" visibility="public">
\t\t<packagedElement xmi:type="uml:Package" xmi:id="${pkg}" name="Technology Architecture - Sintetis" visibility="public">
${packaged}
\t\t</packagedElement>
\t</uml:Model>
\t<xmi:Extension extender="Enterprise Architect" extenderID="6.5">
\t\t<elements>
\t\t\t<element xmi:idref="${pkg}" xmi:type="uml:Package" name="Technology Architecture - Sintetis" scope="public"/>
${ext}
\t\t</elements>
\t\t<connectors>
${conns}
\t\t</connectors>
\t</xmi:Extension>
</xmi:XMI>
`;
}

function csv(): string {
  const cell = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const cols = [
    'GUID',
    'Type',
    'Stereotype',
    'Name',
    'Status',
    'Notes',
    'hostname',
    'ip_address',
    'environment',
    'location',
    'os',
    'os_version',
    'owner',
    'end_of_support',
  ];
  const rows = elements.map((e) =>
    [
      `{${guid(e.name)}}`,
      e.type.replace('uml:', ''),
      e.stereotype,
      e.name,
      e.status ?? 'Approved',
      e.notes ?? '',
      ...cols.slice(6).map((c) => e.tags?.[c] ?? ''),
    ]
      .map(cell)
      .join(','),
  );
  const rel = relations.map(([s, t, type, st], i) =>
    [`{${guid(`rel:${i}:${s}->${t}`)}}`, `{${guid(s)}}`, `{${guid(t)}}`, type, st]
      .map(cell)
      .join(','),
  );
  return (
    [
      cols.join(','),
      ...rows,
      '#relations',
      'GUID,SourceGUID,TargetGUID,Type,Stereotype',
      ...rel,
    ].join('\r\n') + '\r\n'
  );
}

await mkdir(path.join(ROOT, 'fixtures/ta'), { recursive: true });
await writeFile(path.join(ROOT, 'fixtures/ta/sparx-technology-demo.xmi'), xmi());
await writeFile(path.join(ROOT, 'fixtures/ta/technology-template.csv'), csv());
console.log(`${elements.length} elemen, ${relations.length} relasi -> fixtures/ta/`);
