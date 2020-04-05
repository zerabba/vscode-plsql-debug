create or replace and compile
java source named SCHEMA_SAMPLE."com.vscode.VSCodeDebug" authid current_user
as
package com.vscode;
import java.sql.*;

public class VSCodeDebug
{
  public static void evalBreakpoint(String dummy) {
    dummy = dummy + '1';
  }

  public static String evalSqlStmt(String strQuery) throws Exception {
    try {
      Connection con = DriverManager.getConnection("jdbc:default:connection:");
      PreparedStatement qry = con.prepareStatement("select " + strQuery + " from dual");
      ResultSet rs = qry.executeQuery();
      if(rs.next() ) {
        return rs.getString(1);
      } else {
        return "Unable to get result...";
      }
    } catch(Exception e) {
      return "Unable to get result...";
    }
  }
};
/

CREATE OR REPLACE PROCEDURE SCHEMA_SAMPLE.JEvalBreakpoint(ivDummy varchar2) authid current_user
AS LANGUAGE JAVA
NAME 'com.vscode.VSCodeDebug.evalBreakpoint(java.lang.String)';
/

CREATE OR REPLACE PROCEDURE SCHEMA_SAMPLE.evalBreakpoint authid current_user
is
begin
  JEvalBreakpoint(TO_CHAR(CURRENT_TIMESTAMP));
end;
/

CREATE OR REPLACE PUBLIC SYNONYM evalBreakpoint
  FOR SCHEMA_SAMPLE.evalBreakpoint
/
