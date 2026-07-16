import { MapperMapping, JavaTypeSnapshot } from '../types';
import { PathMatcher } from './pathMatcher';

export interface NavigationDiagnosticItem {
  label: string;
  detail?: string;
}

interface JavaDiagnosticInput {
  filePath: string;
  snapshot: JavaTypeSnapshot;
  mappings: MapperMapping[];
  xmlPaths?: string[];
  cache: object;
}

interface XmlDiagnosticInput {
  filePath: string;
  namespace: string;
  mappings: MapperMapping[];
  cache: object;
}

export function buildJavaDiagnosticReport(input: JavaDiagnosticInput): NavigationDiagnosticItem[] {
  const items: NavigationDiagnosticItem[] = [
    { label: '类型', detail: input.snapshot.fqn },
    { label: '类型索引', detail: JSON.stringify(input.cache) }
  ];
  return [...items, ...buildMappingItems(
    input.filePath,
    mergeIndexedXmlPaths(input),
    'XML候选'
  )];
}

export function buildXmlDiagnosticReport(input: XmlDiagnosticInput): NavigationDiagnosticItem[] {
  const items: NavigationDiagnosticItem[] = [
    { label: 'namespace', detail: input.namespace },
    { label: '类型索引', detail: JSON.stringify(input.cache) }
  ];
  return [...items, ...buildMappingItems(input.filePath, input.mappings, 'Mapper候选')];
}

function buildMappingItems(
  referencePath: string,
  mappings: MapperMapping[],
  label: string
): NavigationDiagnosticItem[] {
  if (mappings.length === 0) return [{ label, detail: '无缓存候选' }];
  const ranked = mappings.map(mapping => {
    const targetPath = referencePath.endsWith('.java') ? mapping.xmlPath : mapping.javaPath;
    return { mapping, targetPath, rank: targetPath ? PathMatcher.createMatchRank(referencePath, targetPath) : undefined };
  }).sort((left, right) => {
    if (!left.rank && !right.rank) return (left.targetPath ?? '').localeCompare(right.targetPath ?? '');
    if (!left.rank) return 1;
    if (!right.rank) return -1;
    return PathMatcher.compareMatchRanks(left.rank, right.rank) ||
      (left.targetPath ?? '').localeCompare(right.targetPath ?? '');
  });
  const topRank = ranked.find(candidate => candidate.rank)?.rank;
  const tiedCount = topRank
    ? ranked.filter(candidate => candidate.rank && PathMatcher.compareMatchRanks(candidate.rank, topRank) === 0).length
    : 0;
  return ranked.map(({ targetPath, rank }, index) => {
    const status = !rank
      ? '未绑定'
      : tiedCount > 1
        ? `并列候选: ${tiedCount}`
        : index === 0 ? '选中' : '候选';
    return {
      label,
      detail: `${targetPath ?? '未绑定XML'} | ${status} | ${rank ? JSON.stringify(rank) : '无路径评分'}`
    };
  });
}

function mergeIndexedXmlPaths(input: JavaDiagnosticInput): MapperMapping[] {
  const mappings = [...input.mappings];
  const mappedPaths = new Set(mappings.flatMap(mapping => mapping.xmlPath ? [mapping.xmlPath] : []));
  for (const xmlPath of input.xmlPaths ?? []) {
    if (mappedPaths.has(xmlPath)) continue;
    mappings.push({
      javaPath: input.filePath,
      xmlPath,
      namespace: input.snapshot.fqn,
      className: input.snapshot.className,
      methods: new Map()
    });
  }
  return mappings;
}
