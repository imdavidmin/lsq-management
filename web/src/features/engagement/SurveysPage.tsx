import { useMemo } from "react";
import { Badge, Button, Select, Title1, Title2, makeStyles, tokens } from "@fluentui/react-components";
import { Flag16Filled } from "@fluentui/react-icons";
import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useNavigate, useParams } from "react-router-dom";
import { Can } from "../../auth/Can";
import { Query } from "../../lib/Query";
import { agTheme } from "../../lib/grid";
import { date } from "../../lib/format";
import { useThemeMode } from "../../theme-provider";
import { capitalise } from "../../../../common/strings";
import type { Survey, SurveyResponse } from "../../api/types";
import { StatCard } from "../scoring/Scorecard";
import { useFlagOutlier, useResponses, useSetSurveyClosed, useSurveys } from "./api";

const useStyles = makeStyles({
  page: { display: "grid", gap: tokens.spacingVerticalL },
  row: { display: "flex", gap: tokens.spacingHorizontalM, alignItems: "center" },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: tokens.spacingHorizontalL },
  flag: { color: tokens.colorPaletteRedForeground1, verticalAlign: "middle" },
});

// Average rating per dimension (non-outliers, as scored) and every response, one column per dimension.
function Results({ survey }: { survey: Survey }) {
  const s = useStyles();
  const q = useResponses(survey.id!);

  return (
    <Query q={q}>
      {(rows) => {
        const dims = [...new Set(rows.flatMap((r) => Object.keys(r.answers ?? {})))];
        const counted = rows.filter((r) => !r.is_outlier);
        const avg = (k: string) => {
          const xs = counted.map((r) => r.answers?.[k]).filter((v) => v != null);
          return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : "—";
        };
        return (
          <>
            <div className={s.cards}>
              <StatCard
                label="Responses"
                value={`${survey.non_outlier_count}/50`}
                hint={`${survey.response_count} received, ${survey.non_outlier_count} not outliers. Survey metrics score once 50 non-outlier responses exist.`}
              />
              {dims.map((k) => (
                <StatCard key={k} label={capitalise(k)} value={avg(k)} hint="Average rating (1–5) across non-outlier responses." />
              ))}
            </div>
            <ResponsesGrid surveyId={survey.id!} rows={rows} dims={dims} />
          </>
        );
      }}
    </Query>
  );
}

function ResponsesGrid({ surveyId, rows, dims }: { surveyId: number; rows: SurveyResponse[]; dims: string[] }) {
  const s = useStyles();
  const { dark } = useThemeMode();
  const flag = useFlagOutlier(surveyId);
  const cols = useMemo<ColDef<SurveyResponse>[]>(
    () => [
      { field: "submitted_on", headerName: "Submitted", valueFormatter: (p) => date(p.value), width: 140 },
      ...dims.map<ColDef<SurveyResponse>>((k) => ({
        colId: k,
        headerName: capitalise(k),
        valueGetter: (p) => p.data!.answers?.[k],
        flex: 1,
        minWidth: 120,
        maxWidth: 150, // single-digit scores
      })),
      {
        field: "is_outlier",
        headerName: "Outlier",
        width: 110,
        editable: true,
        singleClickEdit: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: [false, true] },
        valueFormatter: (p) => (p.value ? "Outlier" : "Counted"),
        cellRenderer: (p: { value: boolean }) => p.value && <Flag16Filled className={s.flag} aria-label="Outlier" />,
      },
    ],
    [dims, s.flag]
  );
  return (
    <AgGridReact<SurveyResponse>
      theme={agTheme(dark)}
      rowData={rows}
      columnDefs={cols}
      getRowId={(p) => String(p.data.id)}
      domLayout="autoHeight"
      onCellValueChanged={(e) => flag.mutate({ rid: e.data.id!, is_outlier: e.newValue })}
    />
  );
}

export function SurveysPage() {
  const s = useStyles();
  const q = useSurveys();
  const { id } = useParams();
  const navigate = useNavigate();
  const setClosed = useSetSurveyClosed();
  return (
    <div className={s.page}>
      <Title1>Surveys</Title1>
      <Query q={q}>
        {(surveys) => {
          // Newest first; the URL picks another year.
          const survey = surveys.find((x) => String(x.id) === id) ?? surveys[0];
          if (!survey) return <span>No surveys yet.</span>;
          const open = !survey.closed_at;
          return (
            <>
              <div className={s.row}>
                <Title2>Survey</Title2>
                <Select value={String(survey.id)} onChange={(_, d) => navigate(`/surveys/${d.value}`)}>
                  {surveys.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.service_year}
                    </option>
                  ))}
                </Select>
                <Badge appearance="tint" color={open ? "success" : "informative"}>
                  {open ? "open" : "closed"}
                </Badge>
                <Badge appearance="tint" color={survey.scoring_gate_met ? "success" : "warning"}>
                  {survey.scoring_gate_met ? "scoring" : "pending"}
                </Badge>
                <Can perm="survey:manage">
                  <Button size="small" onClick={() => setClosed.mutate({ id: survey.id!, closed: open })}>
                    {open ? "Close" : "Reopen"}
                  </Button>
                </Can>
              </div>
              <Can perm="survey:manage">
                <Results key={survey.id} survey={survey} />
              </Can>
            </>
          );
        }}
      </Query>
    </div>
  );
}
