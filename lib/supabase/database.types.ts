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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
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
      search_chunks: {
        Args: {
          match_limit?: number
          query_embedding: string
          query_text: string
        }
        Returns: {
          chunk_id: number
          content: string
          document_id: string
          document_title: string
          invoice_id: string
          lexical_rank: number
          rrf_score: number
          source_kind: string
          vector_rank: number
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

