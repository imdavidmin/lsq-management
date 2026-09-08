import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Field,
  Rating,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title1,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Can } from "../../auth/Can";
import { usePermissions } from "../../auth/AuthProvider";
import { Query } from "../../lib/Query";
import { date } from "../../lib/format";
import type { Survey } from "../../api/types";
import {
  useCreateSurvey,
  useFlagOutlier,
  useResponses,
  useSetSurveyClosed,
  useSubmitResponse,
  useSurveys,
} from "./api";

// Survey answers are keyed by the survey-backed metrics (surveys.md).
const QUESTIONS = [
  { key: "cleanliness", label: "Cleanliness" },
  { key: "landscaping", label: "Landscaping" },
  { key: "communication", label: "Communication" },
];

const useStyles = makeStyles({
  card: { padding: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalL, gap: tokens.spacingVerticalM },
  row: { display: "flex", gap: tokens.spacingHorizontalM, alignItems: "center" },
});

function RespondForm({ survey }: { survey: Survey }) {
  const s = useStyles();
  const submit = useSubmitResponse(survey.id!);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const complete = QUESTIONS.every((q) => answers[q.key]);
  if (submit.isSuccess) return <Text>Thanks — your response was recorded.</Text>;
  return (
    <div>
      {QUESTIONS.map((q) => (
        <Field key={q.key} label={q.label}>
          <Rating
            value={answers[q.key] ?? 0}
            max={5}
            onChange={(_, d) => setAnswers((a) => ({ ...a, [q.key]: d.value }))}
          />
        </Field>
      ))}
      <Button
        className={s.row}
        appearance="primary"
        disabled={submit.isPending || !complete}
        onClick={() => submit.mutate(answers)}
      >
        Submit response
      </Button>
      {submit.isError && <Text>{(submit.error as Error).message}</Text>}
    </div>
  );
}

function ResponsesTable({ surveyId }: { surveyId: number }) {
  const q = useResponses(surveyId, true);
  const flag = useFlagOutlier(surveyId);
  return (
    <Query q={q}>
      {(rows) => (
        <Table size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Submitted</TableHeaderCell>
              <TableHeaderCell>Answers</TableHeaderCell>
              <TableHeaderCell>Outlier</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{date(r.submitted_on)}</TableCell>
                <TableCell>{JSON.stringify(r.answers)}</TableCell>
                <TableCell>
                  <Button
                    size="small"
                    appearance={r.is_outlier ? "primary" : "secondary"}
                    onClick={() => flag.mutate({ rid: r.id!, is_outlier: !r.is_outlier })}
                  >
                    {r.is_outlier ? "outlier" : "mark outlier"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Query>
  );
}

function SurveyCard({ survey }: { survey: Survey }) {
  const s = useStyles();
  const { has } = usePermissions();
  const setClosed = useSetSurveyClosed();
  const [showResponses, setShowResponses] = useState(false);
  const open = !survey.closed_at;
  return (
    <Card className={s.card}>
      <div className={s.row}>
        <Title3>Survey {survey.service_year}</Title3>
        <Badge appearance="tint" color={open ? "success" : "informative"}>
          {open ? "open" : "closed"}
        </Badge>
        <Badge appearance="tint" color={survey.scoring_gate_met ? "success" : "warning"}>
          {survey.non_outlier_count}/50 non-outlier
        </Badge>
        <Can perm="survey:manage">
          <Button size="small" onClick={() => setClosed.mutate({ id: survey.id!, closed: open })}>
            {open ? "Close" : "Reopen"}
          </Button>
        </Can>
      </div>

      {open && has("survey:respond") && <RespondForm survey={survey} />}

      <Can perm="survey:manage">
        <Button appearance="subtle" onClick={() => setShowResponses((v) => !v)}>
          {showResponses ? "Hide" : "View"} responses ({survey.response_count})
        </Button>
        {showResponses && <ResponsesTable surveyId={survey.id!} />}
      </Can>
    </Card>
  );
}

export function SurveysPage() {
  const q = useSurveys();
  const create = useCreateSurvey();
  return (
    <div>
      <Title1>Surveys</Title1>
      <Can perm="survey:manage">
        <Button
          appearance="primary"
          disabled={create.isPending}
          onClick={() => create.mutate(new Date().getFullYear())}
          style={{ marginBottom: tokens.spacingVerticalL }}
        >
          New survey ({new Date().getFullYear()})
        </Button>
      </Can>
      <Query q={q}>
        {(surveys) => surveys.map((s) => <SurveyCard key={s.id} survey={s} />)}
      </Query>
    </div>
  );
}
