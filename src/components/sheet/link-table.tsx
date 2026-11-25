import { Cell, Explain, Grid, Mark, Note, Row, Status } from "./bits";

export type LinkPreviewView = {
  links: { asanaBoardId: string; name: string; plakyBoardId: number; paired: number; unmatched: string[]; warnings: string[]; seedRows: number; ready: boolean; subitemsOf: string | null }[];
  missing: { id: string; name: string }[];
  blocking: string[];
  peopleWarnings: string[];
  wanted: number;
  needsConfirm: boolean;
  changes: string[] | null;
};

export function LinkTable({ preview }: { preview: LinkPreviewView }) {
  return (
    <div className="flex flex-col gap-3" data-testid="link-table">
      <p className="text-sm" data-testid="link-found">{preview.links.length} of {preview.wanted} board(s) found in Plaky; {preview.missing.length} still to import.</p>
      <Grid head={["Asana board", "Plaky board", "Fields paired", "Status"]} align={["left", "left", "right", "left"]}>
        {preview.links.map((l) => (
          <Row key={l.asanaBoardId}>
            <Cell>{l.name}</Cell>
            <Cell>#{l.plakyBoardId}</Cell>
            <Cell right>{l.paired}</Cell>
            <Cell className="text-[15px]">
              {l.ready ? <Status kind="done">ready</Status> : <Status kind="flag"><strong>blocked</strong></Status>}
              {l.unmatched.map((u, i) => <div key={`${i}:${u}`} className="mt-1 flex items-start gap-2"><Mark kind="flag" /><span><strong>block:</strong> <Explain text={u} /></span></div>)}
              {l.warnings.map((w, i) => <div key={`${i}:${w}`} className="mt-1 flex items-start gap-2"><Mark kind="now" /><span><strong>warn:</strong> <Explain text={w} /></span></div>)}
              {l.seedRows ? <div className="mt-1 text-cake-muted">{l.seedRows} seed row(s) to delete on link</div> : null}
            </Cell>
          </Row>
        ))}
        {preview.missing.map((m) => (
          <Row key={m.id}><Cell>{m.name}</Cell><Cell className="text-cake-muted">not imported yet: import its seed CSV in Plaky, then check again</Cell><Cell /><Cell /></Row>
        ))}
      </Grid>
      {preview.blocking.map((b, i) => <div key={`${i}:${b}`} className="flex items-start gap-2"><span className="pt-1"><Mark kind="flag" /></span><div><Explain text={b} /></div></div>)}
      {preview.peopleWarnings.map((b, i) => <Note key={`${i}:${b}`}>{b}</Note>)}
      {preview.changes?.map((c, i) => <Note key={`${i}:${c}`}>Re-link change: {c}</Note>)}
    </div>
  );
}
