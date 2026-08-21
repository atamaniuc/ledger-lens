// Generated from the local Supabase schema — do not edit by hand.
// Regenerate with `task types` after any migration; `task types-check`
// (part of `task verify`) fails when this file and the schema disagree.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      agent_request_budget: {
        Row: {
          id: number
          requests: number
          scope: string
          scope_id: string
          window_start: string
        }
        Insert: {
          id?: never
          requests?: number
          scope: string
          scope_id: string
          window_start: string
        }
        Update: {
          id?: never
          requests?: number
          scope?: string
          scope_id?: string
          window_start?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string
          actor_type: string
          correlation_id: string
          created_at: string
          details: Json | null
          entity: string | null
          entity_id: string | null
          id: number
          on_behalf_of: string | null
          org_id: string
        }
        Insert: {
          action: string
          actor_id: string
          actor_type: string
          correlation_id: string
          created_at?: string
          details?: Json | null
          entity?: string | null
          entity_id?: string | null
          id?: never
          on_behalf_of?: string | null
          org_id: string
        }
        Update: {
          action?: string
          actor_id?: string
          actor_type?: string
          correlation_id?: string
          created_at?: string
          details?: Json | null
          entity?: string | null
          entity_id?: string | null
          id?: never
          on_behalf_of?: string | null
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      chunks: {
        Row: {
          chunk_no: number
          content: string
          content_hash: string
          content_tsv: unknown
          created_at: string
          document_id: string | null
          embedding: string
          embedding_model: string
          id: number
          invoice_id: string | null
          org_id: string
          source_kind: string | null
          updated_at: string
        }
        Insert: {
          chunk_no: number
          content: string
          content_hash: string
          content_tsv?: unknown
          created_at?: string
          document_id?: string | null
          embedding: string
          embedding_model: string
          id?: never
          invoice_id?: string | null
          org_id: string
          source_kind?: string | null
          updated_at?: string
        }
        Update: {
          chunk_no?: number
          content?: string
          content_hash?: string
          content_tsv?: unknown
          created_at?: string
          document_id?: string | null
          embedding?: string
          embedding_model?: string
          id?: never
          invoice_id?: string | null
          org_id?: string
          source_kind?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chunks_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chunks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_turns: {
        Row: {
          answer: string
          conversation_id: string
          correlation_id: string
          created_at: string
          id: number
          org_id: string
          outcome: string
          question: string
        }
        Insert: {
          answer: string
          conversation_id: string
          correlation_id: string
          created_at?: string
          id?: never
          org_id: string
          outcome: string
          question: string
        }
        Update: {
          answer?: string
          conversation_id?: string
          correlation_id?: string
          created_at?: string
          id?: never
          org_id?: string
          outcome?: string
          question?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_turns_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_turns_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          correlation_id: string
          created_at: string
          id: string
          org_id: string
          updated_at: string
        }
        Insert: {
          correlation_id: string
          created_at?: string
          id?: string
          org_id: string
          updated_at?: string
        }
        Update: {
          correlation_id?: string
          created_at?: string
          id?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      data_quality_results: {
        Row: {
          check_name: string
          created_at: string
          delta: number | null
          details: Json | null
          expected: number | null
          id: number
          observed: number | null
          org_id: string
          run_id: string | null
          status: string
        }
        Insert: {
          check_name: string
          created_at?: string
          delta?: number | null
          details?: Json | null
          expected?: number | null
          id?: number
          observed?: number | null
          org_id: string
          run_id?: string | null
          status: string
        }
        Update: {
          check_name?: string
          created_at?: string
          delta?: number | null
          details?: Json | null
          expected?: number | null
          id?: number
          observed?: number | null
          org_id?: string
          run_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_quality_results_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_quality_results_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pipeline_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          body: string
          content_hash: string
          created_at: string
          id: string
          kind: string
          org_id: string
          raw_event_id: number | null
          run_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          body: string
          content_hash: string
          created_at?: string
          id?: string
          kind: string
          org_id: string
          raw_event_id?: number | null
          run_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          body?: string
          content_hash?: string
          created_at?: string
          id?: string
          kind?: string
          org_id?: string
          raw_event_id?: number | null
          run_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_raw_event_id_fkey"
            columns: ["raw_event_id"]
            isOneToOne: false
            referencedRelation: "raw_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pipeline_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_cents: number
          currency: string
          customer: string
          external_id: string
          id: string
          issued_at: string
          org_id: string
          paid_at: string | null
          pipeline_version: string
          raw_event_id: number
          run_id: string
          status: string
          transformed_at: string
        }
        Insert: {
          amount_cents: number
          currency: string
          customer: string
          external_id: string
          id?: string
          issued_at: string
          org_id: string
          paid_at?: string | null
          pipeline_version: string
          raw_event_id: number
          run_id: string
          status: string
          transformed_at?: string
        }
        Update: {
          amount_cents?: number
          currency?: string
          customer?: string
          external_id?: string
          id?: string
          issued_at?: string
          org_id?: string
          paid_at?: string | null
          pipeline_version?: string
          raw_event_id?: number
          run_id?: string
          status?: string
          transformed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_raw_event_id_fkey"
            columns: ["raw_event_id"]
            isOneToOne: false
            referencedRelation: "raw_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pipeline_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_calls: {
        Row: {
          correlation_id: string
          cost_cents: number | null
          created_at: string
          id: number
          input_tokens: number | null
          latency_ms: number | null
          model: string
          org_id: string
          outcome: string
          output_tokens: number | null
          preferred_provider: string
          prompt_version: string
          provider: string
          retrieved_chunk_ids: number[] | null
          step_no: number
          tool_args: Json | null
          tool_name: string | null
        }
        Insert: {
          correlation_id: string
          cost_cents?: number | null
          created_at?: string
          id?: never
          input_tokens?: number | null
          latency_ms?: number | null
          model: string
          org_id: string
          outcome: string
          output_tokens?: number | null
          preferred_provider?: string
          prompt_version: string
          provider?: string
          retrieved_chunk_ids?: number[] | null
          step_no?: number
          tool_args?: Json | null
          tool_name?: string | null
        }
        Update: {
          correlation_id?: string
          cost_cents?: number | null
          created_at?: string
          id?: never
          input_tokens?: number | null
          latency_ms?: number | null
          model?: string
          org_id?: string
          outcome?: string
          output_tokens?: number | null
          preferred_provider?: string
          prompt_version?: string
          provider?: string
          retrieved_chunk_ids?: number[] | null
          step_no?: number
          tool_args?: Json | null
          tool_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "llm_calls_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          org_id: string
          role: string
          user_id: string
        }
        Update: {
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      observability_alert_thresholds: {
        Row: {
          alert_name: string
          threshold: number
          unit: string
          updated_at: string
        }
        Insert: {
          alert_name: string
          threshold: number
          unit: string
          updated_at?: string
        }
        Update: {
          alert_name?: string
          threshold?: number
          unit?: string
          updated_at?: string
        }
        Relationships: []
      }
      observability_alerts: {
        Row: {
          alert_name: string
          details: Json | null
          id: number
          last_seen_at: string
          observed: number
          opened_at: string
          org_id: string
          resolved_at: string | null
          severity: string
          status: string
          threshold: number
          unit: string
        }
        Insert: {
          alert_name: string
          details?: Json | null
          id?: never
          last_seen_at?: string
          observed: number
          opened_at?: string
          org_id: string
          resolved_at?: string | null
          severity?: string
          status?: string
          threshold: number
          unit: string
        }
        Update: {
          alert_name?: string
          details?: Json | null
          id?: never
          last_seen_at?: string
          observed?: number
          opened_at?: string
          org_id?: string
          resolved_at?: string | null
          severity?: string
          status?: string
          threshold?: number
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "observability_alerts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          id: string
          name: string
        }
        Insert: {
          id?: string
          name: string
        }
        Update: {
          id?: string
          name?: string
        }
        Relationships: []
      }
      pipeline_runs: {
        Row: {
          correlation_id: string | null
          cursor_from: string | null
          cursor_to: string | null
          error: string | null
          finished_at: string | null
          id: string
          kind: string
          org_id: string
          rows_deduplicated: number
          rows_quarantined: number
          rows_read: number
          rows_written: number
          source: string
          started_at: string
          status: string
        }
        Insert: {
          correlation_id?: string | null
          cursor_from?: string | null
          cursor_to?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          kind: string
          org_id: string
          rows_deduplicated?: number
          rows_quarantined?: number
          rows_read?: number
          rows_written?: number
          source: string
          started_at?: string
          status?: string
        }
        Update: {
          correlation_id?: string | null
          cursor_from?: string | null
          cursor_to?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          kind?: string
          org_id?: string
          rows_deduplicated?: number
          rows_quarantined?: number
          rows_read?: number
          rows_written?: number
          source?: string
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      quarantine: {
        Row: {
          created_at: string
          details: Json | null
          id: number
          org_id: string
          raw_event_id: number | null
          reason: string
          run_id: string
        }
        Insert: {
          created_at?: string
          details?: Json | null
          id?: number
          org_id: string
          raw_event_id?: number | null
          reason: string
          run_id: string
        }
        Update: {
          created_at?: string
          details?: Json | null
          id?: number
          org_id?: string
          raw_event_id?: number | null
          reason?: string
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quarantine_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quarantine_raw_event_id_fkey"
            columns: ["raw_event_id"]
            isOneToOne: false
            referencedRelation: "raw_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quarantine_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pipeline_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_events: {
        Row: {
          event_version: string
          external_id: string
          id: number
          ingested_at: string
          org_id: string
          payload: Json
          payload_hash: string
          run_id: string
          source: string
        }
        Insert: {
          event_version?: string
          external_id: string
          id?: number
          ingested_at?: string
          org_id: string
          payload: Json
          payload_hash: string
          run_id: string
          source: string
        }
        Update: {
          event_version?: string
          external_id?: string
          id?: number
          ingested_at?: string
          org_id?: string
          payload?: Json
          payload_hash?: string
          run_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "raw_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pipeline_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_runs: {
        Row: {
          consumed_at: string | null
          error: string | null
          id: number
          kind: string
          org_id: string
          requested_at: string
          run_id: string | null
          status: string
        }
        Insert: {
          consumed_at?: string | null
          error?: string | null
          id?: never
          kind: string
          org_id: string
          requested_at?: string
          run_id?: string | null
          status?: string
        }
        Update: {
          consumed_at?: string | null
          error?: string | null
          id?: never
          kind?: string
          org_id?: string
          requested_at?: string
          run_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_runs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pipeline_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      signed_request_nonces: {
        Row: {
          created_at: string
          expires_at: string
          nonce: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          nonce: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          nonce?: string
        }
        Relationships: []
      }
    }
    Views: {
      agent_p95_latency: {
        Row: {
          calls: number | null
          org_id: string | null
          p95_latency_ms: number | null
          window_end: string | null
          window_start: string | null
        }
        Relationships: [
          {
            foreignKeyName: "llm_calls_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      freshness_lag: {
        Row: {
          lag_seconds: number | null
          measured_at: string | null
          newest_invoice_at: string | null
          org_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      ingest_error_rate: {
        Row: {
          error_rate_pct: number | null
          failed_runs: number | null
          org_id: string | null
          total_runs: number | null
          window_end: string | null
          window_start: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_daily_cost: {
        Row: {
          calls: number | null
          cost_cents: number | null
          day: string | null
          org_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "llm_calls_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      assert_can_draft_tool: { Args: { p_org_id: string }; Returns: undefined }
      check_agent_budget: {
        Args: {
          p_daily_cost_cap_cents: number
          p_daily_token_cap: number
          p_org_id: string
          p_org_limit: number
          p_user_limit: number
          p_window_seconds: number
        }
        Returns: Json
      }
      consume_request_nonce: {
        Args: { p_expires_at: string; p_nonce: string }
        Returns: boolean
      }
      corpus_index_freshness: {
        Args: { p_org_id: string }
        Returns: {
          newest_indexed: string
          newest_invoice: string
          status: string
        }[]
      }
      enqueue_scheduled_run: {
        Args: { p_kind: string; p_org_id: string }
        Returns: number
      }
      evaluate_observability_alerts: {
        Args: never
        Returns: {
          alert_name: string
          observed: number
          org_id: string
          status: string
          threshold: number
        }[]
      }
      get_conversation_history: {
        Args: { p_conversation_id: string; p_org_id: string }
        Returns: {
          answer: string
          created_at: string
          question: string
        }[]
      }
      ingest_raw_event: {
        Args: {
          p_amount_cents: number
          p_currency: string
          p_customer: string
          p_event_version: string
          p_external_id: string
          p_issued_at: string
          p_org_id: string
          p_payload: Json
          p_payload_hash: string
          p_pipeline_version: string
          p_quarantine_details: Json
          p_quarantine_reason: string
          p_run_id: string
          p_source: string
          p_status: string
        }
        Returns: {
          outcome: string
          raw_event_id: number
        }[]
      }
      ingest_transcript: {
        Args: {
          p_body: string
          p_content_hash: string
          p_event_version: string
          p_external_id: string
          p_kind: string
          p_org_id: string
          p_payload: Json
          p_payload_hash: string
          p_pipeline_version: string
          p_quarantine_details: Json
          p_quarantine_reason: string
          p_run_id: string
          p_source: string
          p_title: string
        }
        Returns: {
          outcome: string
          raw_event_id: number
        }[]
      }
      log_agent_action: {
        Args: {
          p_action: string
          p_correlation_id: string
          p_details: Json
          p_entity: string
          p_entity_id: string
          p_org_id: string
        }
        Returns: number
      }
      log_llm_call: {
        Args: {
          p_correlation_id: string
          p_cost_cents: number
          p_input_tokens: number
          p_latency_ms: number
          p_model: string
          p_org_id: string
          p_outcome: string
          p_output_tokens: number
          p_preferred_provider?: string
          p_prompt_version: string
          p_provider?: string
          p_retrieved_chunk_ids: number[]
          p_step_no: number
          p_tool_args: Json
          p_tool_name: string
        }
        Returns: number
      }
      open_or_update_alert: {
        Args: {
          p_alert_name: string
          p_details: Json
          p_observed: number
          p_org_id: string
          p_threshold: number
          p_unit: string
        }
        Returns: undefined
      }
      reap_abandoned_runs: {
        Args: { p_older_than?: string; p_org_id: string; p_source: string }
        Returns: number
      }
      run_data_quality_checks: {
        Args: {
          p_org_id: string
          p_provider_invoice_count: number
          p_provider_total_cents: number
          p_run_id: string
        }
        Returns: {
          check_name: string
          delta: number
          details: Json
          expected: number
          observed: number
          status: string
        }[]
      }
      save_conversation_turn: {
        Args: {
          p_answer: string
          p_conversation_id: string
          p_correlation_id: string
          p_org_id: string
          p_outcome: string
          p_question: string
        }
        Returns: string
      }
      search_chunks: {
        Args: {
          match_limit: number
          min_similarity: number
          query_embedding: string
          query_text: string
        }
        Returns: {
          chunk_id: number
          content: string
          document_id: string
          document_title: string
          invoice_external_id: string
          invoice_id: string
          lexical_rank: number
          rrf_score: number
          similarity: number
          source_kind: string
          vector_rank: number
        }[]
      }
      try_start_polling_run: {
        Args: { p_correlation_id: string; p_org_id: string; p_source: string }
        Returns: {
          cursor_from: string
          reaped: number
          refused_reason: string
          run_id: string
          started: boolean
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

