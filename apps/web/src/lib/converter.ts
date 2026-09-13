import 'server-only';
import { LocalDocumentConverter, type DocumentConverter } from '@intradocs/core/converter';
import { LOCAL_FORMATS, type SourceFormat } from '@intradocs/core/uploads';
import { WeknoraClient } from '@intradocs/core/weknora';
import { WeknoraParseConverter, WEKNORA_PARSE_FORMATS } from '@intradocs/core/weknora-parse';
import { getAiConfig } from './rag';

/**
 * The converter for this installation and the formats it therefore accepts. PPTX is
 * offered only while WeKnora is configured, because that is where its parser runs; the
 * upload page reads the same list, so a format is never shown as supported when the
 * thing that supports it is off (PRD S05).
 */
export function documentConverter(): { converter: DocumentConverter; formats: SourceFormat[] } {
  const local = new LocalDocumentConverter(process.env);
  const config = getAiConfig();
  if (config.retrieval !== 'weknora-local' || !config.weknora)
    return { converter: local, formats: [...LOCAL_FORMATS] };
  return {
    converter: new WeknoraParseConverter(new WeknoraClient(config.weknora), local),
    formats: [...LOCAL_FORMATS, ...WEKNORA_PARSE_FORMATS],
  };
}

export function acceptedFormats(): SourceFormat[] {
  return documentConverter().formats;
}
